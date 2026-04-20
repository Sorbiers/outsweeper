import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { PhotoListItem, PhotoInfo, MoveResponse, UndoResponse } from '../models/photo.model';

@Injectable({ providedIn: 'root' })
export class PhotoService {
  private http = inject(HttpClient);

  listPhotos(
    folder = 'source',
    options: { offset?: number; limit?: number; sortBy?: string; sortAsc?: boolean; filter?: string } = {},
  ): Observable<{ photos: PhotoListItem[]; total: number; offset: number; source_folder: string }> {
    const params: Record<string, string> = { folder };
    if (options.offset != null) params['offset'] = String(options.offset);
    if (options.limit != null) params['limit'] = String(options.limit);
    if (options.sortBy) params['sort_by'] = options.sortBy;
    if (options.sortAsc != null) params['sort_asc'] = String(options.sortAsc);
    if (options.filter) params['filter'] = options.filter;
    return this.http.get<{ photos: PhotoListItem[]; total: number; offset: number; source_folder: string }>(
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
