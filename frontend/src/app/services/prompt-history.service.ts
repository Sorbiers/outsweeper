import { Injectable, signal } from '@angular/core';
import { STORAGE_KEYS } from '../constants';

/**
 * Remembers positive prompts sent from the Generate dialog (most recent first),
 * persisted for the session so they can be picked and reused.
 */
@Injectable({ providedIn: 'root' })
export class PromptHistoryService {
  private static readonly MAX = 50;

  readonly prompts = signal<string[]>(this.load());

  private load(): string[] {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEYS.GEN_PROMPT_HISTORY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private save(list: string[]): void {
    this.prompts.set(list);
    sessionStorage.setItem(STORAGE_KEYS.GEN_PROMPT_HISTORY, JSON.stringify(list));
  }

  /** Record a prompt at the top, de-duplicated, capped to MAX entries. */
  add(prompt: string): void {
    const p = prompt.trim();
    if (!p) return;
    this.save([p, ...this.prompts().filter(x => x !== p)].slice(0, PromptHistoryService.MAX));
  }

  remove(prompt: string): void {
    this.save(this.prompts().filter(x => x !== prompt));
  }

  clear(): void {
    this.save([]);
  }
}
