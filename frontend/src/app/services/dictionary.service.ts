import { Injectable, signal } from '@angular/core';
import { STORAGE_KEYS } from '../constants';

export interface DictionaryValueLora {
  name: string;
  strengthModel: number;
  strengthClip: number;
}

export interface DictionaryValue {
  value: string;
  weight: number;
  /** Optional LoRA attached to this value; injected once when the value is picked. */
  lora?: DictionaryValueLora;
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

  /** Hard cap on nesting depth, in case a chain of *distinct* dictionaries runs long. */
  private static readonly MAX_DEPTH = 8;

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

  /** True when `text` holds any `{{...}}` placeholder, dictionary or inline. */
  hasTokens(text: string): boolean {
    // `search` ignores the pattern's global flag and lastIndex, so the shared regex is safe.
    return !!text && text.search(DictionaryService.TOKEN) >= 0;
  }

  /** Names of dictionaries referenced by `{{name}}` tokens (ignores inline `{{a|b|c}}`). */
  referencedNames(text: string): string[] {
    const names = new Set<string>();
    if (text) {
      for (const m of text.matchAll(DictionaryService.TOKEN)) {
        if (!m[1].includes('|')) names.add(m[1].trim());
      }
    }
    return [...names];
  }

  /** Add dictionaries not already present (by name) to the in-memory signal only,
   *  without persisting to localStorage — used when generating from a saved flow. */
  mergeInMemory(incoming: Dictionary[]): void {
    const have = new Set(this.dictionaries().map(d => d.name.trim().toLowerCase()));
    const add = incoming.filter(d => d?.name && !have.has(d.name.trim().toLowerCase()));
    if (add.length) this.dictionaries.set([...this.dictionaries(), ...add]);
  }

  /**
   * Resolve every `{{...}}` placeholder:
   *  - `{{a|b|c}}` — pick one of the pipe-separated options at random (equal odds).
   *    An empty option is a real choice of nothing: `{{ story | }}` drops the word
   *    half the time, `{{ x | | | }}` three times in four.
   *  - `{{name}}`  — pick a weighted-random value from the matching dictionary.
   * Placeholders nest — `{{ about {{war|circus}} | }}` — and resolve outermost first:
   * one option is picked, then only the picked text is resolved further, so inner
   * draws (and the LoRAs they carry) happen only when the outer choice keeps them.
   * A dictionary value is resolved the same way, so it may reference other
   * dictionaries. Unknown/empty dictionaries and dictionary self-references (direct
   * or via a cycle) are removed; an unclosed `{{` is left as literal text.
   *
   * When a picked value carries a `lora`, it's appended to `loraSink` (if given) —
   * callers can pass the same array across multiple `substitute()` calls (e.g.
   * positive + negative prompt) to collect every LoRA triggered by one generation.
   */
  substitute(text: string, loraSink: DictionaryValueLora[] = []): string {
    if (!text) return text;
    const replaced = this.resolve(text, new Set(), loraSink);
    // Tidy up spacing left behind by removed/empty substitutions.
    return replaced.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.])/g, '$1').trim();
  }

  /** Recursive resolver. `visited` holds dictionary names already expanded in the
   *  current chain, so a cycle (A -> B -> A) collapses to '' instead of looping. */
  private resolve(text: string, visited: Set<string>, loraSink: DictionaryValueLora[], depth = 0): string {
    if (!text || depth >= DictionaryService.MAX_DEPTH) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{{', i);
      const close = open < 0 ? -1 : DictionaryService.matchingClose(text, open);
      if (close < 0) break;   // no more placeholders, or an unclosed one: the rest is literal
      out += text.slice(i, open) + this.resolveToken(text.slice(open + 2, close), visited, loraSink, depth);
      i = close + 2;
    }
    return out + text.slice(i);
  }

  /** Resolve one placeholder's inner text (between its own `{{` and `}}`). */
  private resolveToken(raw: string, visited: Set<string>, loraSink: DictionaryValueLora[], depth: number): string {
    const options = DictionaryService.splitOptions(raw);
    if (options.length > 1) {
      const picked = options[Math.floor(Math.random() * options.length)].trim();
      return this.resolve(picked, visited, loraSink, depth + 1);
    }
    // A dictionary reference; its name may itself be built from placeholders.
    const name = this.resolve(raw, visited, loraSink, depth + 1).trim();
    if (!name) return '';   // `{{ }}` — and never the unnamed dictionary
    const key = name.toLowerCase();
    if (visited.has(key)) {
      console.warn(`[dictionaries] circular reference detected at {{${name}}} — skipped`);
      return '';
    }
    const dict = this.get(name);
    if (!dict || !dict.values.length) return '';
    const picked = this.pickWeightedValue(dict.values);
    if (!picked) return '';
    if (picked.lora?.name) loraSink.push(picked.lora);
    return this.resolve(picked.value, new Set(visited).add(key), loraSink, depth + 1);
  }

  /** Index of the `}}` that closes the `{{` at `open`, counting nested pairs;
   *  -1 when it is never closed. */
  private static matchingClose(text: string, open: number): number {
    let level = 0;
    for (let i = open; i < text.length - 1; i++) {
      if (text.startsWith('{{', i)) { level++; i++; }
      else if (text.startsWith('}}', i)) { if (--level === 0) return i; i++; }
    }
    return -1;
  }

  /** Split a placeholder's inner text on the `|`s that belong to it — not those
   *  inside a nested placeholder. Empty options are kept: they are real choices. */
  private static splitOptions(raw: string): string[] {
    const options: string[] = [];
    let level = 0;
    let start = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw.startsWith('{{', i)) { level++; i++; }
      else if (raw.startsWith('}}', i)) { level--; i++; }
      else if (raw[i] === '|' && level === 0) { options.push(raw.slice(start, i)); start = i + 1; }
    }
    options.push(raw.slice(start));
    return options;
  }

  /** Weighted-random pick. Values with weight <= 0 are temporarily disabled and
   *  never chosen; if every value is disabled, resolves to nothing picked. */
  private pickWeightedValue(values: DictionaryValue[]): DictionaryValue | null {
    const pool = values.filter(v => (v.weight ?? 0) > 0);
    if (!pool.length) return null;
    const total = pool.reduce((sum, v) => sum + v.weight, 0);
    let r = Math.random() * total;
    for (const v of pool) {
      r -= v.weight;
      if (r < 0) return v;
    }
    return pool[pool.length - 1];
  }
}
