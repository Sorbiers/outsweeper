import { Injectable } from '@angular/core';
import { STORAGE_KEYS } from '../constants';

@Injectable({ providedIn: 'root' })
export class FavoritesService {
  private storageKey(folder: string): string {
    return `${STORAGE_KEYS.FAVORITES_PREFIX}${folder}`;
  }

  load(folder: string): Set<string> {
    try {
      const raw = sessionStorage.getItem(this.storageKey(folder));
      if (raw) return new Set(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    return new Set();
  }

  save(folder: string, favorites: Set<string>): void {
    try {
      const key = this.storageKey(folder);
      if (favorites.size === 0) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify([...favorites]));
    } catch {
      /* ignore */
    }
  }

  toggle(folder: string, filename: string): Set<string> {
    const favs = this.load(folder);
    if (favs.has(filename)) favs.delete(filename);
    else favs.add(filename);
    this.save(folder, favs);
    return favs;
  }

  setAll(folder: string, filenames: string[], favorite: boolean): Set<string> {
    const favs = this.load(folder);
    if (favorite) for (const fn of filenames) favs.add(fn);
    else for (const fn of filenames) favs.delete(fn);
    this.save(folder, favs);
    return favs;
  }

  clear(folder: string): void {
    try {
      sessionStorage.removeItem(this.storageKey(folder));
    } catch {
      /* ignore */
    }
  }
}
