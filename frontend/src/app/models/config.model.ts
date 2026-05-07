export interface AppConfig {
  comfy_url: string;
  lmstudio_url: string;
  selected_name: string;
  dust_name: string;
  thumbnails_name: string;
  root_name: string;
  has_run_comfy_command: boolean;
  has_run_lmstudio_command: boolean;
  widgets?: { gpu_monitor?: boolean; comfy_queue?: boolean };
}
