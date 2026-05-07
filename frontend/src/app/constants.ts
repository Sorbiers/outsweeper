export const SPECIAL_FOLDERS = {
  SELECTED:   '__selected',
  DUST:       '__dust',
  THUMBNAILS: '__thumbnails',
} as const;

export const STORAGE_KEYS = {
  SORT_BY:       'pp_sortBy',
  SORT_ASC:      'pp_sortAsc',
  LMS_MODEL:     'lmstudioModel',
  GEN_STEPS:     'pp_gen_steps',
  GEN_CFG:       'pp_gen_cfg',
  GEN_SAMPLER:        'pp_gen_samplerName',
  GEN_SCHEDULER:      'pp_gen_scheduler',
  GEN_WIDTH:          'pp_gen_width',
  GEN_HEIGHT:         'pp_gen_height',
  GEN_BATCH:          'pp_gen_batchSize',
  GEN_LORA_STEP:      'pp_gen_lora_step',
  GEN_POS_PROMPT:     'pp_gen_positivePrompt',
  GEN_NEG_PROMPT:     'pp_gen_negativePrompt',
  FAVORITES_PREFIX:   'pp_favorites:',
  COMFY_POS:          'pp_comfy_pos',
  WIDGET_POS:         'pp_widget_pos',
} as const;
