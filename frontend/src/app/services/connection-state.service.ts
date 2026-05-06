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

  lastDescribePrompt = 'Describe this image in detail and provide a detailed prompt for t2i. Print ONLY the prompt text, ready for use, without additional explanations and texts. for t2i. Only the prompt text, ready for use, without additional explanations.';
  lastLmPrompt = 'Give me a random prompt for t2i. Print ONLY the prompt text, ready for use, without additional explanations and texts. for t2i. Only the prompt text, ready for use, without additional explanations.';
}
