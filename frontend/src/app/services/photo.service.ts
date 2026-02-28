import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { PhotoListItem, PhotoInfo, MoveResponse, UndoResponse } from '../models/photo.model';

@Injectable({ providedIn: 'root' })
export class PhotoService {
  private http = inject(HttpClient);

  listPhotos(folder = 'source'): Observable<{ photos: PhotoListItem[]; total: number; source_folder: string }> {
    return this.http.get<{ photos: PhotoListItem[]; total: number; source_folder: string }>('/api/photos', { params: { folder } });
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

  sendToComfy(comfyUrl: string, prompt: object): Observable<any> {
    return this.http.post('/api/comfy/prompt', { comfy_url: comfyUrl, prompt });
  }
}
