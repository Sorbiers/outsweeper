import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { SPECIAL_FOLDERS } from '../constants';
import {
  PhotoListItem, PhotoInfo, MoveResponse, UndoResponse,
  ExiftoolCapabilities, ExiftoolMetadata, EditableFields, StripGroup,
  BatchEditResult, ComfyQueueJob, CollectionsResponse, CollectionFlow, FlowDocument,
  UpscaleCapabilities, BgRemoveCapabilities,
} from '../models/photo.model';

/** Path prefix understood by the backend resolver for the local flows collection. */
export const COLLECTION_PREFIX = '%collection%';
import { AppConfig } from '../models/config.model';

export interface SidecarFile {
  name: string;
  size: number;
  truncated: boolean;
  content: string;
}

/** A step-review artifact written by a "Record steps" job. */
export interface StepArtifact {
  kind: 'sheet' | 'animation';
  name: string;
  size: number;
  /** Path under the working folder, for /api/photo. */
  path: string;
}

export interface SidecarResponse {
  txt: SidecarFile | null;
  json: SidecarFile | null;
  steps: StepArtifact[];
}
import { Job, JobPayload, JobQueueState } from '../models/job.model';

@Injectable({ providedIn: 'root' })
export class PhotoService {
  private http = inject(HttpClient);
  thumbnailsName: string = SPECIAL_FOLDERS.THUMBNAILS;

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
      tags?: string[];
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
    if (options.tags?.length) params['tags'] = options.tags.join(',');
    return this.http.get<{ photos: PhotoListItem[]; total: number; offset: number; source_name: string }>(
      '/api/photos', { params });
  }

  getInfo(filename: string, folder = ''): Observable<PhotoInfo> {
    return this.http.get<PhotoInfo>('/api/info', { params: { path: this.filePath(filename, folder) } });
  }

  getImageUrl(filename: string, folder = '', modifiedToken?: string): string {
    const path = encodeURIComponent(this.filePath(filename, folder));
    const tok  = modifiedToken ? `&modified=${modifiedToken}` : '';
    return `/api/photo?path=${path}${tok}`;
  }

  getThumbnailUrl(filename: string, folder = '', modifiedToken?: string): string {
    const path = encodeURIComponent(this.filePath(filename, folder));
    const tok  = modifiedToken ? `&modified=${modifiedToken}` : '';
    return `/api/thumbnail?path=${path}${tok}`;
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

  getComfyModels(comfyUrl: string): Observable<{ models: { name: string; type: 'checkpoint' | 'unet' }[] }> {
    return this.http.post<any>('/api/comfy/models', { comfy_url: comfyUrl });
  }

  getComfyUpscaleModels(comfyUrl: string): Observable<{ models: string[] }> {
    return this.http.post<{ models: string[] }>('/api/comfy/upscale-models', { comfy_url: comfyUrl });
  }

  upscaleCapabilities(): Observable<UpscaleCapabilities> {
    return this.http.get<UpscaleCapabilities>('/api/upscale/capabilities');
  }

  /** Path of an image relative to the working folder, for a job payload. */
  jobPath(filename: string, folder = ''): string {
    return this.filePath(filename, folder);
  }

  bgRemoveCapabilities(): Observable<BgRemoveCapabilities> {
    return this.http.get<BgRemoveCapabilities>('/api/bgremove/capabilities');
  }

  /** Background removal via rembg; writes a transparent PNG next to the source. */
  removeBgRembg(filename: string, folder: string, model: string, alphaMatting: boolean): Observable<{ ok: boolean; filename: string }> {
    return this.http.post<{ ok: boolean; filename: string }>(
      '/api/bgremove/rembg',
      { model, alpha_matting: alphaMatting },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  /** Background removal via BiRefNet (torch/GPU); writes a transparent PNG next to the source. */
  removeBgBirefnet(filename: string, folder: string, model: string): Observable<{ ok: boolean; filename: string }> {
    return this.http.post<{ ok: boolean; filename: string }>(
      '/api/bgremove/birefnet',
      { model },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  getComfyQueue(comfyUrl: string): Observable<{ running: ComfyQueueJob[]; pending: ComfyQueueJob[] }> {
    return this.http.post<{ running: ComfyQueueJob[]; pending: ComfyQueueJob[] }>('/api/comfy/queue', { comfy_url: comfyUrl });
  }

  deleteComfyQueueJob(comfyUrl: string, promptId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/comfy/queue/delete', { comfy_url: comfyUrl, prompt_id: promptId });
  }

  moveComfyQueueJobToFront(comfyUrl: string, promptId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/comfy/queue/front', { comfy_url: comfyUrl, prompt_id: promptId });
  }

  clearComfyQueue(comfyUrl: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/comfy/queue/clear', { comfy_url: comfyUrl });
  }

  interruptComfy(comfyUrl: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/comfy/interrupt', { comfy_url: comfyUrl });
  }

  uploadToComfy(comfyUrl: string, filename: string, folder: string): Observable<{ name: string }> {
    return this.http.post<any>(
      '/api/comfy/upload',
      { comfy_url: comfyUrl },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  getConfig(): Observable<AppConfig> {
    return this.http.get<AppConfig>('/api/config');
  }

  setMetricsPaused(paused: boolean, clientId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/metrics/pause', { paused, client_id: clientId });
  }

  setComfyQueuePaused(paused: boolean, clientId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/comfy-queue/pause', { paused, client_id: clientId });
  }

  setLmStudioWidgetPaused(paused: boolean, clientId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/lmstudio/pause', { paused, client_id: clientId });
  }

  /** Launch a desktop editor on the file. Returns as soon as it is spawned. */
  openWith(editor: 'paint' | 'photo_editor', filename: string, folder = ''): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/open-with', { editor },
      { params: { path: this.filePath(filename, folder) } });
  }

  /** Same-stem .txt / .json beside the image — dataset captions and tags. */
  getSidecars(filename: string, folder = ''): Observable<SidecarResponse> {
    return this.http.get<SidecarResponse>('/api/sidecar',
      { params: { path: this.filePath(filename, folder) } });
  }

  /** Post the painted coverage; the backend merges it into the source's alpha and
   *  returns the path to hand to a job's `upload`, which uploads it at run time. */
  saveMask(sourcePath: string, coverageDataUrl: string): Observable<{ path: string }> {
    return this.http.post<{ path: string }>(
      `/api/masks?path=${encodeURIComponent(sourcePath)}`, { coverage: coverageDataUrl });
  }

  // --- internal job queue ---------------------------------------------------

  /** Queue a non-interactive operation. The backend runs it one-at-a-time behind
   *  the ComfyUI/LM Studio resource guards, independent of this browser tab. */
  enqueueJob(kind: string, title: string, payload: JobPayload): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/jobs', { kind, title, payload });
  }

  getJobs(): Observable<JobQueueState> {
    return this.http.get<JobQueueState>('/api/jobs');
  }

  getJob(id: string): Observable<Job & { result: Record<string, any> }> {
    return this.http.get<Job & { result: Record<string, any> }>(`/api/jobs/${id}`);
  }

  cancelJob(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/jobs/${id}/cancel`, {});
  }

  cancelAllJobs(): Observable<{ ok: boolean; cancelled: number }> {
    return this.http.post<{ ok: boolean; cancelled: number }>('/api/jobs/cancel-all', {});
  }

  reorderJobs(ids: string[]): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/jobs/reorder', { ids });
  }

  setJobsPaused(paused: boolean): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/jobs/pause', { paused });
  }

  setJobSettings(settings: { force_clear_comfy?: boolean; auto_start?: boolean }):
      Observable<{ ok: boolean; force_clear_comfy: boolean; auto_start: boolean }> {
    return this.http.post<{ ok: boolean; force_clear_comfy: boolean; auto_start: boolean }>(
      '/api/jobs/settings', settings);
  }

  clearFinishedJobs(): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/jobs/clear-finished', {});
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

  collectionPath(collection: string, set: string): string {
    return `${COLLECTION_PREFIX}/${collection}/${set}`;
  }

  listCollections(): Observable<CollectionsResponse> {
    return this.http.get<CollectionsResponse>('/api/collections');
  }

  addToCollection(
    filenames: string[], sourceFolder: string, collection: string, set: string,
  ): Observable<{ ok: boolean; count: number; errors: string[] }> {
    return this.batchOperation({
      filenames,
      operation:   'copy',
      destination: this.collectionPath(collection, set),
      zip:         false,
      folder:      sourceFolder,
    });
  }

  deleteFromCollection(relPath: string): Observable<{ ok: boolean; error?: string }> {
    return this.http.post<{ ok: boolean; error?: string }>(
      '/api/collections/delete', { path: relPath });
  }

  /** Save a { flow, dictionaries } document as <name>.json into a collection set. */
  saveFlowToCollection(collectionPath: string, name: string, content: unknown): Observable<{ ok: boolean; filename?: string; error?: string }> {
    return this.http.post<{ ok: boolean; filename?: string; error?: string }>(
      '/api/collections/save-flow', { name, content }, { params: { path: collectionPath } });
  }

  /** List the .json flow documents in a collection set. */
  listCollectionFlows(collectionPath: string): Observable<{ flows: CollectionFlow[] }> {
    return this.http.get<{ flows: CollectionFlow[] }>(
      '/api/collections/flows', { params: { path: collectionPath } });
  }

  /** Read a saved flow document. `filePath` is the full %collection% path to the .json. */
  readCollectionFlow(filePath: string): Observable<FlowDocument> {
    return this.http.get<FlowDocument>('/api/collections/flow', { params: { path: filePath } });
  }

  /** Move an image from one collection/set to another. */
  moveBetweenCollections(
    filename: string, fromCollection: string, fromSet: string, toCollection: string, toSet: string,
  ): Observable<{ ok: boolean; count: number; errors: string[] }> {
    return this.batchOperation({
      filenames:   [filename],
      operation:   'move',
      destination: this.collectionPath(toCollection, toSet),
      zip:         false,
      folder:      this.collectionPath(fromCollection, fromSet),
    });
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

  sendToComfy(comfyUrl: string, prompt: object, copyResult = false, front = false): Observable<any> {
    return this.http.post('/api/comfy/prompt', {
      comfy_url: comfyUrl, prompt, copy_result: copyResult, front,
    });
  }

  /** Non-blocking status check for a submitted prompt (poll until done). While the
   *  job runs it returns {done:false}; once finished, {done:true} with the copied
   *  output filenames. Lets a long generation be awaited without a blocking request. */
  comfyResult(comfyUrl: string, promptId: string): Observable<{ done: boolean; queued?: boolean; filenames?: string[]; status?: string }> {
    return this.http.post<{ done: boolean; queued?: boolean; filenames?: string[]; status?: string }>(
      '/api/comfy/result', { comfy_url: comfyUrl, prompt_id: promptId });
  }

  checkLmStudio(lmstudioUrl: string): Observable<any> {
    return this.http.post('/api/lmstudio/check', { lmstudio_url: lmstudioUrl });
  }

  /** The model LM Studio currently has loaded (both null when none is). */
  getLmStudioLoaded(lmstudioUrl: string): Observable<{ key: string | null; instance: string | null }> {
    return this.http.post<{ key: string | null; instance: string | null }>(
      '/api/lmstudio/loaded', { lmstudio_url: lmstudioUrl });
  }

  lmPrompt(lmstudioUrl: string, prompt: string, model: string): Observable<{ description: string }> {
    return this.http.post<{ description: string }>('/api/lmstudio/prompt', { lmstudio_url: lmstudioUrl, prompt, model });
  }

  describePhoto(filename: string, folder: string, lmstudioUrl: string, prompt: string, model: string): Observable<{ description: string }> {
    return this.http.post<{ description: string }>(
      '/api/describe',
      { lmstudio_url: lmstudioUrl, prompt, model },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  writeMeta(filename: string, folder: string, description: string, key?: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      '/api/write-meta',
      key ? { description, key } : { description },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  runCommand(service: 'comfy' | 'lmstudio'): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/run-command', { service });
  }

  locate(filename: string, folder: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      '/api/locate', {},
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  exiftoolCapabilities(): Observable<ExiftoolCapabilities> {
    return this.http.get<ExiftoolCapabilities>('/api/exiftool/capabilities');
  }

  getExiftoolMetadata(filename: string, folder: string): Observable<ExiftoolMetadata> {
    return this.http.get<ExiftoolMetadata>(
      '/api/exiftool/metadata',
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  editMetadata(filename: string, folder: string, fields: EditableFields): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      '/api/exiftool/edit',
      { fields },
      { params: { path: this.filePath(filename, folder) } },
    );
  }

  editMetadataBatch(filenames: string[], folder: string, fields: EditableFields): Observable<BatchEditResult> {
    return this.http.post<BatchEditResult>(
      '/api/exiftool/edit-batch',
      { filenames, folder, fields },
    );
  }

  stripMetadata(filename: string, folder: string, groups: StripGroup[]): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      '/api/exiftool/strip',
      { groups },
      { params: { path: this.filePath(filename, folder) } },
    );
  }
}
