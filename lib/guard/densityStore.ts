export type Density = "comfortable" | "compact";

export type Unsubscribe = () => void;

export const DENSITY_STORAGE_KEY = "display-density";

export interface DensityStore {
  subscribe(fn: (value: Density) => void): Unsubscribe;
  set(value: Density): void;
  update(updater: (value: Density) => Density): void;
  get(): Density;
}

function createDensityStore(initial: Density = "comfortable"): DensityStore {
  let current: Density = initial;
  const subscribers = new Set<(value: Density) => void>();

  return {
    subscribe(fn: (value: Density) => void) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    set(value: Density) {
      current = value;
      for (const fn of Array.from(subscribers)) {
        fn(current);
      }
    },
    update(updater: (value: Density) => Density) {
      this.set(updater(current));
    },
    get() {
      return current;
    },
  };
}

/**
 * Display density preference store.
 *
 * Values:
 * - "comfortable": Default padding and font sizes
 * - "compact": Reduced padding (~40% smaller), smaller monospace fonts, condensed timestamps
 */
export const density = createDensityStore("comfortable");

/**
 * Initialize density preference from localStorage
 */
export function initDensityStore() {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (saved === "comfortable" || saved === "compact") {
      density.set(saved);
    } else {
      density.set("comfortable");
    }
  }

  // Subscribe to changes and persist to localStorage
  return density.subscribe((value) => {
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(DENSITY_STORAGE_KEY, value);
      } catch {
        // QuotaExceeded or security error in private mode
      }
    }
  });
}

/**
 * Get CSS class for density mode
 */
export function densityClass(d: "comfortable" | "compact"): string {
  return d === "compact" ? "compact" : "comfortable";
}
