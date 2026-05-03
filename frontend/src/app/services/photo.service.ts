import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { PhotoListItem, PhotoInfo, MoveResponse, UndoResponse } from '../models/photo.model';

@Injectable({ providedIn: 'root' })
export class PhotoService {
  private http = inject(HttpClient);
  thumbnailsName = '__thumbnails';

  private filePath(filename: string, folder: string): string {
    return folder ? `${folder}/${filename}` : filename;
  }

  listPhotos(
    folder = '',
    options: {
      offset?: number; limit?: number; sortBy?: string; sortAsc?: boolean; filter?: string;
      dateField?: string; dateFrom?: string; dateTo?: string;
      types?: string[]; sizeMin?: number | null; sizeMax?: number | null;
      widthMin?: number | null; widthMax?: number | null;
      heightMin?: number | null; heightMax?: number | null;
    } = {},
  ): Observable<{ photos: PhotoListItem[]; total: number; offset: number; source_name: string }> {
    const params: Record<string, string> = { path: folder };
    if (options.offset != null) params['offset'] = String(options.offset);
    if (options.limit != null) params['limit'] = String(options.limit);
    if (options.sortBy) params['sort_by'] = options.sortBy;
    if (options.sortAsc != null) params['sort_asc'] = String(options.sortAsc);
    if (options.filter) params['filter'] = options.filter;
    if (options.dateField) params['date_field'] = options.dateField;
    if (options.dateFrom) params['date_from'] = options.dateFrom;
    if (options.dateTo) params['date_to'] = options.dateTo;
    if (options.types?.length) params['types'] = options.types.join(',');
    if (options.sizeMin != null) params['size_min'] = String(options.sizeMin);
    if (options.sizeMax != null) params['size_max'] = String(options.sizeMax);
    if (options.widthMin != null) params['width_min'] = String(options.widthMin);
    if (options.widthMax != null) params['width_max'] = String(options.widthMax);
    if (options.heightMin != null) params['height_min'] = String(options.heightMin);
    if (options.heightMax != null) params['height_max'] = String(options.heightMax);
    return this.http.get<{ photos: PhotoListItem[]; total: number; offset: number; source_name: string }>(
      '/api/photos', { params });
  }

  getInfo(filename: string, folder = ''): Observable<PhotoInfo> {
    return this.http.get<PhotoInfo>('/api/info', { params: { path: this.filePath(filename, folder) } });
  }

  getImageUrl(filename: string, folder = ''): string {
    return `/api/photo?path=${encodeURIComponent(this.filePath(filename, folder))}`;
  }

  getThumbnailUrl(filename: string, folder = ''): string {
    return `/api/thumbnail?path=${encodeURIComponent(this.filePath(filename, folder))}`;
  }

  move(filename: string, fromFolder: string, toFolder: string): Observable<MoveResponse> {
    return this.http.post<MoveResponse>(
      '/api/move',
      { destination: toFolder },
      { params: { path: this.filePath(filename, fromFolder) } },
    );
  }

  undo(): Observable<UndoResponse> {
    return this.http.post<UndoResponse>('/api/undo', {});
  }

  checkComfy(comfyUrl: string): Observable<any> {
    return this.http.post('/api/comfy/check', { comfy_url: comfyUrl });
  }

  getComfyLoras(comfyUrl: string): Observable<{ loras: string[] }> {
    return this.http.post<{ loras: string[] }>('/api/comfy/loras', { comfy_url: comfyUrl });
  }

  getComfyCheckpoints(comfyUrl: string): Observable<{ checkpoints: string[] }> {
    return this.http.post<{ checkpoints: string[] }>('/api/comfy/checkpoints', { comfy_url: comfyUrl });
  }

  getComfySamplers(comfyUrl: string): Observable<{ samplers: string[]; schedulers: string[] }> {
    return this.http.post<{ samplers: string[]; schedulers: string[] }>('/api/comfy/samplers', { comfy_url: comfyUrl });
  }

  getConfig(): Observable<{
    comfy_url: string; lmstudio_url: string;
    widgets: { gpu_monitor: boolean; comfy_queue: boolean };
    selected_name: string; dust_name: string; thumbnails_name: string; root_name: string;
  }> {
    return this.http.get<any>('/api/config');
  }

  setMetricsPaused(paused: boolean, clientId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/metrics/pause', { paused, client_id: clientId });
  }

  setComfyQueuePaused(paused: boolean, clientId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/comfy-queue/pause', { paused, client_id: clientId });
  }

  getTools(): Observable<{ tools: string[] }> {
    return this.http.get<{ tools: string[] }>('/api/tools');
  }

  runTool(name: string, filename: string, folder: string): Observable<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.http.post<any>(
      '/api/tools/run',
      { name },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  refresh(folder = ''): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/refresh', {}, { params: { path: folder } });
  }

  unloadLmStudio(lmstudioUrl: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/lmstudio/unload', { lmstudio_url: lmstudioUrl });
  }

  freeComfy(comfyUrl: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/comfy/free', { comfy_url: comfyUrl });
  }

  batchOperation(params: {
    filenames: string[]; operation: 'copy' | 'move';
    destination: string; use_comfy_output?: boolean;
    zip: boolean; folder: string;
  }): Observable<{ ok: boolean; count: number; errors: string[] }> {
    const { folder, ...body } = params;
    return this.http.post<{ ok: boolean; count: number; errors: string[] }>(
      '/api/batch', body, { params: { path: folder } });
  }

  downloadFile(filename: string, folder: string): void {
    const a = document.createElement('a');
    a.href = this.getImageUrl(filename, folder);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async downloadZip(filenames: string[], folder: string, downloadName = 'photos.zip'): Promise<void> {
    const resp = await fetch(`/api/zip?path=${encodeURIComponent(folder)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames }),
    });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  getFileTypes(folder = ''): Observable<{ types: string[] }> {
    return this.http.get<{ types: string[] }>('/api/file-types', { params: { path: folder } });
  }

  listFolders(): Observable<{
    folders: string[]; root_name: string;
    comfy_output: string | null; comfy_output_name: string | null;
    selected_name: string; dust_name: string;
  }> {
    return this.http.get<any>('/api/folders');
  }

  sendToComfy(comfyUrl: string, prompt: object): Observable<any> {
    return this.http.post('/api/comfy/prompt', { comfy_url: comfyUrl, prompt });
  }

  checkLmStudio(lmstudioUrl: string): Observable<any> {
    return this.http.post('/api/lmstudio/check', { lmstudio_url: lmstudioUrl });
  }

  describePhoto(filename: string, folder: string, lmstudioUrl: string, prompt: string, model: string): Observable<{ description: string }> {
    return this.http.post<{ description: string }>(
      '/api/describe',
      { lmstudio_url: lmstudioUrl, prompt, model },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  writeMeta(filename: string, folder: string, description: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      '/api/write-meta',
      { description },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  locate(filename: string, folder: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      '/api/locate', {},
      { params: { path: this.filePath(filename, folder) } },
    );
  }
}
