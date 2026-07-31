import type { DictionaryValue } from '../services/dictionary.service';

export interface PhotoListItem {
  filename: string;
  modified: string;
  modified_token?: string;
  size: number;
  size_human: string;
  width?: number;
  height?: number;
  favorite?: boolean;
  loaded?: boolean;
}

export interface PhotoInfo extends PhotoListItem {
  created?: string;
  width: number;
  height: number;
  format: string;
  comfyui: ComfyUIData | null;
  exif: Record<string, string>;
  png_metadata: Record<string, string>;
  gps?: Record<string, string>;
  icc?: Record<string, string>;
  tags?: string;
}

export interface ComfyUIData {
  found: boolean;
  model?: string;
  loras?: LoraInfo[];
  prompt?: string;
  negative_prompt?: string;
  steps?: number;
  cfg?: number;
  seed?: number;
  sampler?: string;
  scheduler?: string;
  batch_size?: number;
  denoise?: number;
  source_image?: string;
  error?: string;
}

export interface LoraInfo {
  name: string;
  strength_model: number;
  strength_clip: number;
}

export interface MoveResponse {
  ok: boolean;
  action: string;
  filename: string;
  destination: string;
}

export interface UndoResponse {
  ok: boolean;
  action?: string;
  filename?: string;
  restored_to?: string;
  error?: string;
}

export interface ExiftoolCapabilities {
  available: boolean;
  version: string | null;
  executable: string;
  error: string | null;
}

/** Flat dict of exiftool tags as returned by `-j -G1 -a -s`, e.g. { 'EXIF:Make': 'Nikon', ... }. */
export type ExiftoolMetadata = Record<string, string>;

export interface EditableFields {
  image_title?: string;
  artist?: string;
  description?: string;
  document_name?: string;
  copyright?: string;
  user_comment?: string;
}

export interface BatchEditResult {
  ok: boolean;
  count: number;
  succeeded: string[];
  errors: { path: string; error: string }[];
}

export type StripGroup = 'all' | 'sensitive' | 'icc' | 'exif' | 'gps';

export interface ComfyQueueJob {
  prompt_id: string;
  model: string | null;
  steps: number | null;
  prompt: string | null;
}

export interface CollectionSet {
  name: string;
  count: number;
}

export interface Collection {
  name: string;
  sets: CollectionSet[];
}

export interface CollectionsResponse {
  root_name: string;
  collections: Collection[];
}

/** A saved flow document (.json) inside a collection set. */
export interface CollectionFlow {
  filename: string;
  size: number;
  modified: string;
  modified_token?: string;
}

/** Contents of a saved flow: the full ComfyUI workflow plus the dictionaries it references. */
export interface FlowDocument {
  flow: Record<string, any>;
  dictionaries: Record<string, DictionaryValue[]>;
}

/** What the local (non-ComfyUI) upscale features can currently do. */
export interface UpscaleCapabilities {
  /** torch + spandrel importable in the backend. */
  spandrel: boolean;
  /** A CUDA device is available (else spandrel runs on CPU — slow). */
  cuda: boolean;
  /** Interpolation (Pillow) — always available. */
  interpolation: boolean;
  /** Configured upscale_models_dir, or null when unset. */
  models_dir: string | null;
  /** Model files discovered under models_dir. */
  models: string[];
  /** Interpolation method names (nearest/bilinear/area/bicubic/lanczos). */
  methods: string[];
  /** Import error when spandrel/torch are missing. */
  error: string | null;
}
