// One repeating load that runs only while the page is visible: it pauses when
// the tab is hidden and loads again at once when it is shown. A failure clears
// the data, so screens show an unavailable state instead of old numbers.
export type PollState<T> = { data: T | null; failing: boolean };

export type PollDeps<T> = {
  load: () => Promise<T>;
  // Wait before the next load, measured after the previous one finished.
  delayMs: () => number;
  isHidden: () => boolean;
  watchVisibility: (cb: () => void) => () => void;
  onChange: (state: PollState<T>) => void;
};

export function startPolling<T>(deps: PollDeps<T>): () => void {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  async function run() {
    if (stopped || inFlight) return;
    clear();
    inFlight = true;
    try {
      const data = await deps.load();
      if (!stopped) deps.onChange({ data, failing: false });
    } catch {
      if (!stopped) deps.onChange({ data: null, failing: true });
    } finally {
      inFlight = false;
    }
    if (!stopped && !deps.isHidden()) timer = setTimeout(() => void run(), deps.delayMs());
  }

  const unwatch = deps.watchVisibility(() => {
    if (deps.isHidden()) clear();
    else void run();
  });
  if (!deps.isHidden()) void run();

  return () => {
    stopped = true;
    clear();
    unwatch();
  };
}
