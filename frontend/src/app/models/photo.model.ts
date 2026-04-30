export interface PhotoListItem {
  filename: string;
  modified: string;
  size: number;
  size_human: string;
  width?: number;
  height?: number;
  favorite?: boolean;
  loaded?: boolean;
}

export interface PhotoInfo extends PhotoListItem {
  width: number;
  height: number;
  format: string;
  comfyui: ComfyUIData;
  exif: Record<string, string>;
  png_metadata: Record<string, string>;
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
