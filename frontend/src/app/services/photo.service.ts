import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { PhotoListItem, PhotoInfo, MoveResponse, UndoResponse } from '../models/photo.model';

@Injectable({ providedIn: 'root' })
export class PhotoService {
  private http = inject(HttpClient);

  listPhotos(): Observable<{ photos: PhotoListItem[]; total: number; source_folder: string }> {
    return this.http.get<{ photos: PhotoListItem[]; total: number; source_folder: string }>('/api/photos');
  }

  getInfo(filename: string): Observable<PhotoInfo> {
    return this.http.get<PhotoInfo>(`/api/photos/${encodeURIComponent(filename)}/info`);
  }

  getImageUrl(filename: string): string {
    return `/api/photos/${encodeURIComponent(filename)}/image`;
  }

  getThumbnailUrl(filename: string): string {
    return `/api/photos/${encodeURIComponent(filename)}/thumbnail`;
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
}
