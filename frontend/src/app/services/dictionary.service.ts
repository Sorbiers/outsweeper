import { Injectable, signal } from '@angular/core';
import { STORAGE_KEYS } from '../constants';

export interface DictionaryValue {
  value: string;
  weight: number;
}

export interface Dictionary {
  name: string;
  values: DictionaryValue[];
}

/**
 * Named value-sets used for weighted-random substitution of `{{name}}`
 * placeholders in Generate-dialog prompts. Persisted in localStorage.
 */
@Injectable({ providedIn: 'root' })
export class DictionaryService {
  /** Matches `{{ name }}` placeholders (inner text without braces). */
  private static readonly TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

  readonly dictionaries = signal<Dictionary[]>(this.load());

  private load(): Dictionary[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.DICTIONARIES);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Persist the given list and update the in-memory signal. */
  save(list: Dictionary[]): void {
    this.dictionaries.set(list);
    localStorage.setItem(STORAGE_KEYS.DICTIONARIES, JSON.stringify(list));
  }

  /** Look up a dictionary by name (trimmed, case-insensitive). */
  get(name: string): Dictionary | undefined {
    const n = name.trim().toLowerCase();
    return this.dictionaries().find(d => d.name.trim().toLowerCase() === n);
  }

  /**
   * Resolve every `{{...}}` placeholder:
   *  - `{{a|b|c}}` — pick one of the pipe-separated options at random (equal odds).
   *  - `{{name}}`  — pick a weighted-random value from the matching dictionary.
   * Unknown/empty dictionaries (and empty option lists) are removed.
   */
  substitute(text: string): string {
    if (!text) return text;
    const replaced = text.replace(DictionaryService.TOKEN, (_match, raw: string) => {
      if (raw.includes('|')) {
        const options = raw.split('|').map(s => s.trim()).filter(Boolean);
        return options.length ? options[Math.floor(Math.random() * options.length)] : '';
      }
      const dict = this.get(raw);
      if (!dict || !dict.values.length) return '';
      return this.pickWeighted(dict.values);
    });
    // Tidy up spacing left behind by removed/empty substitutions.
    return replaced.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.])/g, '$1').trim();
  }

  private pickWeighted(values: DictionaryValue[]): string {
    const positive = values.filter(v => (v.weight ?? 0) > 0);
    // Fall back to a uniform pick when no positive weights are defined.
    const pool = positive.length ? positive : values;
    const weightOf = (v: DictionaryValue) => (positive.length ? v.weight : 1);
    const total = pool.reduce((sum, v) => sum + weightOf(v), 0);
    let r = Math.random() * total;
    for (const v of pool) {
      r -= weightOf(v);
      if (r < 0) return v.value;
    }
    return pool[pool.length - 1].value;
  }
}
