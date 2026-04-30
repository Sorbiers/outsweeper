import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { PhotoListItem, PhotoInfo, MoveResponse, UndoResponse } from '../models/photo.model';

@Injectable({ providedIn: 'root' })
export class PhotoService {
  private http = inject(HttpClient);
  thumbnailsName = '__thumbnails';

  listPhotos(
    folder = '',
    options: {
      offset?: number; limit?: number; sortBy?: string; sortAsc?: boolean; filter?: string;
      favoritesOnly?: boolean;
      dateField?: string; dateFrom?: string; dateTo?: string;
      types?: string[]; sizeMin?: number | null; sizeMax?: number | null;
      widthMin?: number | null; widthMax?: number | null;
      heightMin?: number | null; heightMax?: number | null;
    } = {},
  ): Observable<{ photos: PhotoListItem[]; total: number; offset: number; source_folder: string; source_name: string }> {
    const params: Record<string, string> = { folder };
    if (options.offset != null) params['offset'] = String(options.offset);
    if (options.limit != null) params['limit'] = String(options.limit);
    if (options.sortBy) params['sort_by'] = options.sortBy;
    if (options.sortAsc != null) params['sort_asc'] = String(options.sortAsc);
    if (options.filter) params['filter'] = options.filter;
    if (options.favoritesOnly) params['favorites_only'] = 'true';
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
    return this.http.get<{ photos: PhotoListItem[]; total: number; offset: number; source_folder: string; source_name: string }>(
      '/api/photos',
      { params },
    );
  }

  getInfo(filename: string, folder = ''): Observable<PhotoInfo> {
    return this.http.get<PhotoInfo>(`/api/photos/${encodeURIComponent(filename)}/info`, { params: { folder } });
  }

  getImageUrl(filename: string, folder = ''): string {
    const rel = folder ? `${folder}/${filename}` : filename;
    return '/api/photos/' + rel.split('/').map(encodeURIComponent).join('/');
  }

  getThumbnailUrl(filename: string, folder = ''): string {
    const rel = folder
      ? `${folder}/${this.thumbnailsName}/${filename}`
      : `${this.thumbnailsName}/${filename}`;
    return '/api/photos/' + rel.split('/').map(encodeURIComponent).join('/');
  }

  move(filename: string, fromFolder: string, toFolder: string): Observable<MoveResponse> {
    return this.http.post<MoveResponse>(
      `/api/photos/${encodeURIComponent(filename)}/move`,
      { folder: fromFolder, destination: toFolder }
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

  getConfig(): Observable<{ comfy_url: string; lmstudio_url: string; widgets: { gpu_monitor: boolean; comfy_queue: boolean }; selected_name: string; dust_name: string; thumbnails_name: string; root_name: string }> {
    return this.http.get<{ comfy_url: string; lmstudio_url: string; widgets: { gpu_monitor: boolean; comfy_queue: boolean }; selected_name: string; dust_name: string; thumbnails_name: string; root_name: string }>('/api/config');
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
    return this.http.post<any>('/api/tools/run', { name, filename, folder });
  }

  refresh(folder = ''): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/refresh', { folder });
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
    return this.http.post<{ ok: boolean; count: number; errors: string[] }>('/api/batch', params);
  }

  toggleFavorite(filename: string, folder: string): Observable<{ ok: boolean; favorite: boolean }> {
    return this.http.post<{ ok: boolean; favorite: boolean }>(
      `/api/photos/${encodeURIComponent(filename)}/favorite`, {}, { params: { folder } });
  }

  setFavorites(filenames: string[], favorite: boolean, folder: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/favorites', { filenames, favorite, folder });
  }

  downloadFavorites(folder: string): void {
    window.location.href = `/api/favorites/download?folder=${encodeURIComponent(folder)}`;
  }

  getFileTypes(folder = ''): Observable<{ types: string[] }> {
    return this.http.get<{ types: string[] }>('/api/file-types', { params: { folder } });
  }

  listFolders(): Observable<{ folders: string[]; root_name: string; current: string | null; comfy_output: string | null; comfy_output_name: string | null; comfy_output_active: boolean; selected_name: string; dust_name: string }> {
    return this.http.get<{ folders: string[]; root_name: string; current: string | null; comfy_output: string | null; comfy_output_name: string | null; comfy_output_active: boolean; selected_name: string; dust_name: string }>('/api/folders');
  }

  sendToComfy(comfyUrl: string, prompt: object): Observable<any> {
    return this.http.post('/api/comfy/prompt', { comfy_url: comfyUrl, prompt });
  }

  checkLmStudio(lmstudioUrl: string): Observable<any> {
    return this.http.post('/api/lmstudio/check', { lmstudio_url: lmstudioUrl });
  }

  describePhoto(filename: string, folder: string, lmstudioUrl: string, prompt: string, model: string): Observable<{ description: string }> {
    return this.http.post<{ description: string }>(
      `/api/photos/${encodeURIComponent(filename)}/describe`,
      { lmstudio_url: lmstudioUrl, prompt, model, folder }
    );
  }

  writeMeta(filename: string, folder: string, description: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      `/api/photos/${encodeURIComponent(filename)}/write-meta`,
      { folder, description }
    );
  }

  locate(filename: string, folder: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      `/api/photos/${encodeURIComponent(filename)}/locate`,
      { folder }
    );
  }
}
