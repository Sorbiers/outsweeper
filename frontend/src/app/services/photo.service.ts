import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { PhotoListItem, PhotoInfo, MoveResponse, UndoResponse } from '../models/photo.model';

@Injectable({ providedIn: 'root' })
export class PhotoService {
  private http = inject(HttpClient);

  listPhotos(
    folder = 'source',
    options: {
      offset?: number; limit?: number; sortBy?: string; sortAsc?: boolean; filter?: string;
      dateField?: string; dateFrom?: string; dateTo?: string;
      types?: string[]; sizeMin?: number | null; sizeMax?: number | null;
    } = {},
  ): Observable<{ photos: PhotoListItem[]; total: number; offset: number; source_folder: string; source_name: string }> {
    const params: Record<string, string> = { folder };
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
    return this.http.get<{ photos: PhotoListItem[]; total: number; offset: number; source_folder: string; source_name: string }>(
      '/api/photos',
      { params },
    );
  }

  getInfo(filename: string, folder = 'source'): Observable<PhotoInfo> {
    return this.http.get<PhotoInfo>(`/api/photos/${encodeURIComponent(filename)}/info`, { params: { folder } });
  }

  getImageUrl(filename: string, folder = 'source'): string {
    return `/api/photos/${encodeURIComponent(filename)}/image?folder=${folder}`;
  }

  getThumbnailUrl(filename: string, folder = 'source'): string {
    return `/api/photos/${encodeURIComponent(filename)}/thumbnail?folder=${folder}`;
  }

  moveToSelected(filename: string): Observable<MoveResponse> {
    return this.http.post<MoveResponse>(
      `/api/photos/${encodeURIComponent(filename)}/move`,
      { destination: 'selected' }
    );
  }

  moveToDust(filename: string): Observable<MoveResponse> {
    return this.http.post<MoveResponse>(
      `/api/photos/${encodeURIComponent(filename)}/move`,
      { destination: 'dust' }
    );
  }

  moveToSource(filename: string, fromFolder: string): Observable<MoveResponse> {
    return this.http.post<MoveResponse>(
      `/api/photos/${encodeURIComponent(filename)}/move`,
      { destination: 'source', folder: fromFolder }
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

  getConfig(): Observable<{ comfy_url: string; lmstudio_url: string }> {
    return this.http.get<{ comfy_url: string; lmstudio_url: string }>('/api/config');
  }

  refresh(): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/refresh', {});
  }

  unloadLmStudio(lmstudioUrl: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/lmstudio/unload', { lmstudio_url: lmstudioUrl });
  }

  freeComfy(comfyUrl: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/comfy/free', { comfy_url: comfyUrl });
  }

  getFileTypes(): Observable<{ types: string[] }> {
    return this.http.get<{ types: string[] }>('/api/file-types');
  }

  listFolders(): Observable<{ folders: string[]; root_name: string; current: string | null; comfy_output: string | null; comfy_output_name: string | null; comfy_output_active: boolean }> {
    return this.http.get<{ folders: string[]; root_name: string; current: string | null; comfy_output: string | null; comfy_output_name: string | null; comfy_output_active: boolean }>('/api/folders');
  }

  changeFolder(folder: string): Observable<{ ok: boolean; source_name: string }> {
    return this.http.post<{ ok: boolean; source_name: string }>('/api/change-folder', { folder });
  }

  changeToComfyOutput(): Observable<{ ok: boolean; source_name: string }> {
    return this.http.post<{ ok: boolean; source_name: string }>('/api/change-folder', { use_comfy_output: true });
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
}
