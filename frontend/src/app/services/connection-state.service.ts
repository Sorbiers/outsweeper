import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ConnectionStateService {
  comfy = {
    url: '',
    status: 'idle' as 'idle' | 'checking' | 'ok' | 'error',
    loras: [] as string[],
    checkpoints: [] as string[],
    samplers: [] as string[],
    schedulers: [] as string[],
  };

  lmstudio = {
    url: '',
    status: 'idle' as 'idle' | 'checking' | 'ok' | 'error',
    models: [] as string[],
  };

  lastDescribePrompt = 'Describe this image in detail and provide a detailed prompt for t2i AI generators. Print ONLY the prompt text, ready for use, without additional explanations and texts.';
  lastLmPrompt = 'Give me a random prompt for t2i AI generators. Print ONLY the prompt text, ready for use, without additional explanations and texts.';
  /** Generate dialog's "Ask LM Studio": asks for prompts on blank-line-separated
   *  paragraphs, the shape Multiple prompts splits on by default. */
  lastLmChat = "Give me 10 random t2i prompts for surrealistic illustrations of futuristic night dreams. Only prompts texts separated by an empty line, no more explications. For each prompt add 'In baroque style, highly detailed, high quality digital artwork, 8k'.";
}
