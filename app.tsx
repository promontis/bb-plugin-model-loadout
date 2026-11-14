import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useBbContext,
  useComposer,
  useRealtime,
  useRpc,
  useSdk,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import type { LoadoutConfig, LoadoutItem, rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Sdk = ReturnType<typeof useSdk>;
type ModelsResult = Awaited<ReturnType<Sdk["providers"]["models"]>>;
type AvailableModel = ModelsResult["models"][number];
type ProviderState = ReturnType<typeof useProviders>;
type Provider = ProviderState["providers"][number];
type Catalog = {
  models: readonly AvailableModel[];
  error: string | null;
  loading: boolean;
};
type ReasoningLevel = LoadoutItem["reasoningLevel"];

const MAX_LOADOUT = 5;
/** A touch that moves further than this is a scroll, not a tap. */
const TAP_SLOP_PX = 10;

/**
 * Composers whose model selector popup is open. The trigger reports it as
 * aria-expanded, like BB's own selector: BB's compact (phone) composer keeps
 * itself expanded while a trigger in it says its popup is open, and
 * collapses otherwise, which takes the popup down with it.
 */
const openSelectorComposers = new Set<string>();
const openSelectorListeners = new Set<() => void>();

function setSelectorOpen(composerKey: string, open: boolean) {
  if (open) openSelectorComposers.add(composerKey);
  else openSelectorComposers.delete(composerKey);
  for (const listener of openSelectorListeners) listener();
}

function subscribeSelectorOpen(listener: () => void) {
  openSelectorListeners.add(listener);
  return () => {
    openSelectorListeners.delete(listener);
  };
}

function useSelectorOpen(composerKey: string): boolean {
  return useSyncExternalStore(subscribeSelectorOpen, () =>
    openSelectorComposers.has(composerKey),
  );
}
const DRAG_TYPE = "application/x-bb-model-loadout";
const LOADOUT_CHANGED = "loadout-changed";

function itemKey(item: Pick<LoadoutItem, "providerId" | "model">): string {
  return `${item.providerId}\0${item.model}`;
}

function displayEffort(value: string): string {
  if (value === "xhigh") return "Extra High";
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function useLoadout() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<LoadoutConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    rpc.call("loadout_get").then(
      (next) => {
        latestItems = next.items;
        setConfig(next);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(refresh, [refresh]);
  useRealtime(LOADOUT_CHANGED, refresh);

  const save = useCallback(
    async (next: LoadoutConfig) => {
      setConfig(next);
      try {
        const saved = await rpc.call("loadout_save", next);
        latestItems = saved.items;
        setConfig(saved);
        setError(null);
        return saved;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        refresh();
        throw cause;
      }
    },
    [refresh, rpc],
  );

  return { config, error, save };
}

function useEnvironmentId(): string | null {
  const { threadId } = useBbContext();
  const { threads } = useSidebarThreads();
  return (
    threads.find((thread) => thread.id === threadId)?.environment?.id ?? null
  );
}

function useCatalogs(providers: readonly Provider[]) {
  const sdk = useSdk();
  const environmentId = useEnvironmentId();
  const providerIds = useMemo(
    () => providers.filter((provider) => provider.available).map((provider) => provider.id),
    [providers],
  );
  const providerKey = providerIds.join("\0");
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});

  useEffect(() => {
    const controller = new AbortController();
    setCatalogs(
      Object.fromEntries(
        providerIds.map((providerId) => [
          providerId,
          { models: [], error: null, loading: true },
        ]),
      ),
    );
    for (const providerId of providerIds) {
      const request =
        environmentId === null
          ? { providerId, preferCached: true, signal: controller.signal }
          : {
              providerId,
              preferCached: true,
              signal: controller.signal,
              environmentId,
            };
      sdk.providers
        .models(request)
        .then(
          (result) => {
            if (controller.signal.aborted) return;
            setCatalogs((current) => ({
              ...current,
              [providerId]: {
                models: [...result.models, ...result.selectedOnlyModels],
                error: result.modelLoadError?.detail ?? null,
                loading: false,
              },
            }));
          },
          (cause) => {
            if (controller.signal.aborted) return;
            setCatalogs((current) => ({
              ...current,
              [providerId]: {
                models: [],
                error: cause instanceof Error ? cause.message : String(cause),
                loading: false,
              },
            }));
          },
        );
    }
    return () => controller.abort();
  }, [environmentId, providerKey, sdk]);

  return catalogs;
}

function recommendedItems(
  providers: readonly Provider[],
  catalogs: Readonly<Record<string, Catalog>>,
): LoadoutItem[] {
  const items: LoadoutItem[] = [];
  for (const provider of providers) {
    const catalog = catalogs[provider.id];
    if (catalog?.loading !== false) continue;
    const model = catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
    if (model === undefined) continue;
    items.push({
      providerId: provider.id,
      model: model.model,
      reasoningLevel: model.defaultReasoningEffort as ReasoningLevel,
      ...(model.supportedServiceTiers?.some((tier) => tier.id === "default")
        ? { serviceTier: "default" }
        : {}),
    });
    if (items.length === MAX_LOADOUT) break;
  }
  return items;
}

function useModelLoadout() {
  const providerState = useProviders();
  const providers = providerState.providers;
  const catalogs = useCatalogs(providers);
  const loadout = useLoadout();

  useEffect(() => {
    if (loadout.config === null || loadout.config.initialized) return;
    if (providers.length === 0) return;
    if (providers.some((provider) => catalogs[provider.id]?.loading !== false)) return;
    void loadout.save({
      version: 1,
      initialized: true,
      items: recommendedItems(providers, catalogs),
    });
  }, [catalogs, loadout.config, loadout.save, providers]);

  return { ...loadout, providers, catalogs, providerStatus: providerState.status };
}

function findModel(
  item: Pick<LoadoutItem, "providerId" | "model">,
  catalogs: Readonly<Record<string, Catalog>>,
): AvailableModel | undefined {
  return catalogs[item.providerId]?.models.find((model) => model.model === item.model);
}

function findProvider(providerId: string, providers: readonly Provider[]) {
  return providers.find((provider) => provider.id === providerId);
}

function ModelMark({ provider, className }: { provider: Provider | undefined; className?: string }) {
  return provider === undefined ? (
    <Icon name="Bot" className={className} aria-hidden />
  ) : (
    <ProviderIcon
      providerKind="agent"
      provider={provider}
      fallback="Bot"
      className={className}
      aria-hidden
    />
  );
}

function SelectorAction() {
  const composer = useComposer();
  const isOpen = useSelectorOpen(composer.key);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // Report the popup open in the same render that mounts it, before focus
  // moves into it: BB's phone composer checks the trigger then.
  const openSelector = () => {
    setSelectorOpen(composer.key, true);
    if (!composer.experimental_openPopup("model-selector")) {
      setSelectorOpen(composer.key, false);
    }
  };
  const selection = composer.selection;
  const { config, providers, catalogs } = useModelLoadout();
  if (selection?.providerId === undefined || selection.model === undefined) return null;
  const item =
    config?.items.find(
      (candidate) =>
        candidate.providerId === selection.providerId && candidate.model === selection.model,
    ) ?? { providerId: selection.providerId, model: selection.model };
  const model = findModel(item, catalogs);
  const provider = findProvider(selection.providerId, providers);
  return (
    <button
      type="button"
      data-model-loadout-trigger=""
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      data-state={isOpen ? "open" : "closed"}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        touchStart.current = touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
      }}
      onTouchEnd={(event) => {
        // On iOS with the keyboard up, the emulated click moves focus out of
        // the editor first; the keyboard closes, the composer drops, and the
        // click lands where the button no longer is. Open on the tap itself
        // and cancel the emulated click, so nothing moves under the finger.
        const start = touchStart.current;
        touchStart.current = null;
        const touch = event.changedTouches[0];
        if (start === null || touch === undefined) return;
        if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_SLOP_PX) return;
        event.preventDefault();
        openSelector();
      }}
      onClick={openSelector}
      className="flex h-7 max-w-56 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
      aria-label="Choose agent and model"
      title="Choose agent and model"
    >
      <ModelMark provider={provider} className="size-4 shrink-0" />
      <span className="min-w-0 truncate text-foreground">
        {model?.displayName ?? selection.model}
      </span>
      {selection.reasoningLevel === undefined ? null : (
        <span className="shrink-0 text-subtle-foreground">
          {displayEffort(selection.reasoningLevel)}
        </span>
      )}
      <Icon name="ChevronDown" className="size-3.5 shrink-0" aria-hidden />
    </button>
  );
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SHORTCUT_LABELS = {
  model: (n: number) => (IS_MAC ? `⌃⌘${n}` : `Ctrl+Alt+${n}`),
  fast: IS_MAC ? "⌥F" : "Alt+F",
  cycleEffort: IS_MAC ? "⌥T" : "Alt+T",
};

/** Latest loadout, so keyboard commands can run without a mounted popup. */
let latestItems: readonly LoadoutItem[] = [];

function Kbd({ children, boxed = false }: { children: string; boxed?: boolean }) {
  return (
    <kbd
      className={cn(
        "shrink-0 font-sans text-[12px] tracking-wide text-subtle-foreground",
        boxed && "rounded-[5px] border border-border px-1.5 py-0.5 text-muted-foreground",
      )}
    >
      {children}
    </kbd>
  );
}

function FastSwitch({ on, onToggle }: { on: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      role="switch"
      data-model-loadout-fast=""
      aria-checked={on}
      aria-label="Fast"
      onClick={onToggle}
      className={cn(
        "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
        on ? "bg-primary" : "bg-foreground/15",
      )}
    >
      <span
        className={cn(
          "absolute left-[3px] top-[3px] size-4 rounded-full bg-foreground/90 shadow-sm transition-transform",
          on ? "translate-x-4 bg-background" : "translate-x-0",
        )}
      />
    </button>
  );
}

function ModelSelectorPopup() {
  const composer = useComposer();
  useLayoutEffect(() => {
    setSelectorOpen(composer.key, true);
    return () => setSelectorOpen(composer.key, false);
  }, [composer.key]);
  const { config, error, save, providers, catalogs } = useModelLoadout();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState(0);
  const popupRef = useRef<HTMLDivElement>(null);
  const [effortOpen, setEffortOpenState] = useState(false);
  const [effortSide, setEffortSide] = useState<"right" | "left">("right");
  const setEffortOpen = (next: boolean | ((open: boolean) => boolean)) => {
    const rect = popupRef.current?.getBoundingClientRect();
    if (rect !== undefined) setEffortSide(rect.right + 176 > window.innerWidth ? "left" : "right");
    setEffortOpenState(next);
  };
  const selection = composer.selection;
  const items = config?.items ?? [];
  const filtered = items.filter((item) => {
    const model = findModel(item, catalogs);
    const provider = findProvider(item.providerId, providers);
    const haystack = `${model?.displayName ?? item.model} ${provider?.displayName ?? item.providerId}`;
    return haystack.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  const currentItem = items.find(
    (item) =>
      item.providerId === selection?.providerId && item.model === selection?.model,
  );
  const currentModel =
    selection?.providerId === undefined || selection.model === undefined
      ? undefined
      : findModel({ providerId: selection.providerId, model: selection.model }, catalogs);

  useEffect(() => {
    const index = filtered.findIndex(
      (item) => item.providerId === selection?.providerId && item.model === selection?.model,
    );
    setActive(index === -1 ? 0 : index);
    // Only reset the highlight when the list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filtered.length]);

  const choose = async (item: LoadoutItem) => {
    if (pending) return;
    setPending(true);
    try {
      await composer.setSelection({
        providerId: item.providerId,
        model: item.model,
        reasoningLevel: item.reasoningLevel,
        ...(item.serviceTier === undefined ? {} : { serviceTier: item.serviceTier }),
      });
      composer.experimental_closePopup();
    } finally {
      setPending(false);
    }
  };

  const setEffort = async (reasoningLevel: LoadoutItem["reasoningLevel"]) => {
    setEffortOpen(false);
    await composer.setSelection({ reasoningLevel });
    if (currentItem === undefined || config === null) return;
    await save({
      ...config,
      items: config.items.map((item) =>
        itemKey(item) === itemKey(currentItem) ? { ...item, reasoningLevel } : item,
      ),
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + filtered.length) % filtered.length);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      const item = filtered[active];
      if (item === undefined || findModel(item, catalogs) === undefined) return;
      event.preventDefault();
      void choose(item);
    }
  };

  useLayoutEffect(() => {
    const popup = popupRef.current;
    const composerBox = popup?.closest("[data-promptbox]");
    const trigger = composerBox?.querySelector<HTMLElement>("[data-model-loadout-trigger]");
    if (popup == null || composerBox == null || trigger == null) return;
    const GAP = 6;
    const MARGIN = 8;
    // Anchor the popup to the selector button, not to BB's composer-wide popup frame.
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const box = composerBox.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      const alignRight = anchor.left + anchor.width / 2 > box.left + box.width / 2;
      const left = Math.max(
        MARGIN,
        Math.min(alignRight ? anchor.right - width : anchor.left, window.innerWidth - width - MARGIN),
      );
      const above = anchor.top - GAP - height;
      const top =
        above >= MARGIN
          ? above
          : Math.max(MARGIN, Math.min(anchor.bottom + GAP, window.innerHeight - height - MARGIN));
      popup.style.position = "fixed";
      popup.style.zIndex = "60";
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
      // A transformed ancestor shifts fixed elements; correct by the measured offset.
      const actual = popup.getBoundingClientRect();
      if (Math.abs(actual.left - left) > 0.5) popup.style.left = `${2 * left - actual.left}px`;
      if (Math.abs(actual.top - top) > 0.5) popup.style.top = `${2 * top - actual.top}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(popup);
    observer.observe(composerBox);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, []);

  const fastTier = currentModel?.supportedServiceTiers?.find((tier) => tier.id === "fast");
  const fast = selection?.serviceTier === "fast";
  const efforts = currentModel?.supportedReasoningEfforts ?? [];

  return (
    <div
      ref={popupRef}
      data-model-loadout-popup=""
      onKeyDown={onKeyDown}
      className="w-[min(22rem,calc(100vw-1rem))] rounded-[14px] border border-border bg-popover p-1 text-popover-foreground shadow-xl"
    >
      <div
        data-model-loadout-card=""
        className="rounded-[10px] border border-border/70 bg-foreground/[0.035]"
      >
        <div className="relative flex h-10 items-center border-b border-border/70 px-3">
          <Icon name="Search" className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            aria-label="Search loadout models"
            className="h-9 border-0 bg-transparent px-2.5 text-[14px] shadow-none placeholder:text-subtle-foreground focus-visible:ring-0"
          />
        </div>

        <div aria-label="Models" className="max-h-[18rem] overflow-y-auto p-1">
          {error !== null ? <p className="px-2 py-2 text-xs text-destructive">{error}</p> : null}
          {config === null ? (
            <p className="px-2.5 py-2 text-[13px] text-muted-foreground">Loading models…</p>
          ) : filtered.length === 0 ? (
            <p className="px-2.5 py-2 text-[13px] text-muted-foreground">
              {items.length === 0 ? "Your model loadout is empty." : "No matching models."}
            </p>
          ) : (
            filtered.map((item, index) => {
              const model = findModel(item, catalogs);
              const provider = findProvider(item.providerId, providers);
              const selected =
                selection?.providerId === item.providerId && selection.model === item.model;
              const otherAgent =
                composer.scope.kind === "thread" &&
                selection?.providerId !== undefined &&
                selection.providerId !== item.providerId;
              const slot = items.indexOf(item) + 1;
              return (
                <button
                  key={itemKey(item)}
                  type="button"
                  aria-pressed={selected}
                  disabled={pending || model === undefined}
                  onClick={() => void choose(item)}
                  onMouseMove={() => setActive(index)}
                  title={otherAgent ? `Hand off to ${provider?.displayName ?? item.providerId}` : undefined}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left",
                    index === active ? "bg-state-hover" : "",
                    selected && "bg-state-selected",
                    model === undefined && "opacity-50",
                  )}
                >
                  <Icon name="DragDropVertical" className="size-3.5 shrink-0 text-subtle-foreground/70" aria-hidden />
                  <ModelMark provider={provider} className="size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="truncate text-[14px] text-foreground">
                      {model?.displayName ?? item.model}
                    </span>
                    <span className="shrink-0 text-[13px] text-subtle-foreground">
                      {displayEffort(item.reasoningLevel)}
                    </span>
                  </span>
                  {selected ? (
                    <Icon name="Check" className="size-4 shrink-0 text-foreground" aria-hidden />
                  ) : otherAgent ? (
                    <Icon name="ArrowUpRight" className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
                  ) : (
                    <Kbd>{SHORTCUT_LABELS.model(slot)}</Kbd>
                  )}
                </button>
              );
            })
          )}
        </div>

        {currentModel === undefined || (efforts.length === 0 && fastTier === undefined) ? null : (
          <div className="border-t border-border/70 p-1">
            {efforts.length === 0 ? null : (
              <div
                className="relative"
                onMouseEnter={() => setEffortOpen(true)}
                onMouseLeave={() => setEffortOpen(false)}
              >
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={effortOpen}
                  onClick={() => setEffortOpen(true)}
                  className={cn(
                    "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-state-hover",
                    effortOpen && "bg-state-hover",
                  )}
                >
                  <span className="flex-1 text-[14px]">Effort</span>
                  <span className="text-[13px] text-muted-foreground">
                    {selection?.reasoningLevel === undefined
                      ? "Default"
                      : displayEffort(selection.reasoningLevel)}
                  </span>
                  <Icon name="ChevronRight" className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
                </button>
                {effortOpen ? (
                  <div
                    className={cn(
                      "absolute bottom-0 z-50",
                      effortSide === "right" ? "left-full pl-2.5" : "right-full pr-2.5",
                    )}
                  >
                    <div role="menu" aria-label="Effort" className="w-40 rounded-[10px] border border-border bg-popover p-1 shadow-xl">
                      {efforts.map((effort) => {
                        const checked = selection?.reasoningLevel === effort.reasoningEffort;
                        return (
                          <button
                            key={effort.reasoningEffort}
                            type="button"
                            role="menuitemradio"
                            aria-checked={checked}
                            data-model-loadout-effort={effort.reasoningEffort}
                            onClick={() => void setEffort(effort.reasoningEffort as ReasoningLevel)}
                            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-state-hover"
                          >
                            <span className="flex-1">{displayEffort(effort.reasoningEffort)}</span>
                            {checked ? <Icon name="Check" className="size-3.5 shrink-0" aria-hidden /> : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            {fastTier === undefined ? null : (
              <div className="flex h-9 items-center gap-3 px-2">
                <span className="flex-1 text-[14px]">Fast</span>
                <Kbd>{SHORTCUT_LABELS.fast}</Kbd>
                <FastSwitch
                  on={fast}
                  onToggle={() => void composer.setSelection({ serviceTier: fast ? "default" : "fast" })}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex h-9 items-center justify-between px-2.5">
        <a
          href="/settings/plugins/model-loadout"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <Icon name="Settings" className="size-3.5" aria-hidden />
          Edit
        </a>
        {efforts.length === 0 ? null : (
          <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
            <Kbd boxed>{SHORTCUT_LABELS.cycleEffort}</Kbd>
            Cycle effort
          </span>
        )}
      </div>
    </div>
  );
}

function LoadoutCard({
  item,
  index,
  providers,
  catalogs,
  onRemove,
  onEffort,
  onDrop,
}: {
  item: LoadoutItem;
  index: number;
  providers: readonly Provider[];
  catalogs: Readonly<Record<string, Catalog>>;
  onRemove(): void;
  onEffort(reasoningLevel: LoadoutItem["reasoningLevel"]): void;
  onDrop(event: DragEvent, index: number): void;
}) {
  const provider = findProvider(item.providerId, providers);
  const model = findModel(item, catalogs);
  return (
    <div
      draggable
      onDragStart={(event) => event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, index)}
      className="group relative flex min-h-36 min-w-40 flex-col border-r border-border p-4 last:border-r-0"
    >
      {index === 0 ? (
        <span className="absolute right-3 top-3 rounded border border-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          Default
        </span>
      ) : null}
      <ModelMark provider={provider} className="size-8" />
      <div className="mt-auto min-w-0 pt-4">
        <div className="truncate font-mono text-sm font-medium">
          {model?.displayName ?? item.model}
        </div>
        {model === undefined ? (
          <p className="mt-1 text-xs text-destructive">Unavailable</p>
        ) : (
          <select
            value={item.reasoningLevel}
            onChange={(event) =>
              onEffort(event.target.value as LoadoutItem["reasoningLevel"])
            }
            className="mt-1 max-w-full bg-transparent text-sm text-muted-foreground outline-none"
            aria-label={`Effort for ${model.displayName}`}
          >
            {model.supportedReasoningEfforts.map((effort) => (
              <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
                {displayEffort(effort.reasoningEffort)}
              </option>
            ))}
          </select>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-2 bottom-2 rounded p-1 text-subtle-foreground opacity-0 transition-opacity hover:bg-state-hover hover:text-foreground group-hover:opacity-100 focus:opacity-100"
        aria-label={`Remove ${model?.displayName ?? item.model} from loadout`}
      >
        <Icon name="Cancel01" className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function EmptyLoadoutSlot({ index, onDrop }: { index: number; onDrop(event: DragEvent, index: number): void }) {
  return (
    <div
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, index)}
      className="flex min-h-36 min-w-40 items-center justify-center border-r border-dashed border-border p-4 last:border-r-0"
    >
      <span className="font-mono text-[10px] uppercase tracking-wider text-subtle-foreground">
        Drop model here
      </span>
    </div>
  );
}

function DefaultModelsSettings() {
  const { config, error, save, providers, catalogs, providerStatus } = useModelLoadout();
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const items = config?.items ?? [];
  const selected = useMemo(() => new Set(items.map(itemKey)), [items]);

  const commitItems = (nextItems: LoadoutItem[]) => {
    if (config === null) return;
    void save({ ...config, initialized: true, items: nextItems.slice(0, MAX_LOADOUT) });
  };

  const add = (providerId: string, model: AvailableModel, at = items.length) => {
    const candidate: LoadoutItem = {
      providerId,
      model: model.model,
      reasoningLevel: model.defaultReasoningEffort as ReasoningLevel,
      ...(model.supportedServiceTiers?.some((tier) => tier.id === "default")
        ? { serviceTier: "default" }
        : {}),
    };
    const without = items.filter((item) => itemKey(item) !== itemKey(candidate));
    without.splice(Math.min(at, without.length), 0, candidate);
    commitItems(without);
  };

  const handleDrop = (event: DragEvent, index: number) => {
    event.preventDefault();
    setDragging(false);
    try {
      const dropped = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as Partial<LoadoutItem>;
      if (typeof dropped.providerId !== "string" || typeof dropped.model !== "string") return;
      const existing = items.find(
        (item) => item.providerId === dropped.providerId && item.model === dropped.model,
      );
      if (existing !== undefined) {
        const next = items.filter((item) => itemKey(item) !== itemKey(existing));
        next.splice(Math.min(index, next.length), 0, existing);
        commitItems(next);
        return;
      }
      const model = catalogs[dropped.providerId]?.models.find(
        (candidate) => candidate.model === dropped.model,
      );
      if (model !== undefined) add(dropped.providerId, model, index);
    } catch {
      // Ignore drags that did not originate from this settings section.
    }
  };

  return (
    <div className="space-y-8 pb-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Default models</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose and order the models shown in your composer selector.
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Loadout</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            The first model is your default preset. Drag models to reorder them.
          </p>
        </div>
        <div
          className={cn(
            "grid overflow-x-auto rounded-lg border border-border bg-card",
            "grid-flow-col auto-cols-[minmax(10rem,1fr)]",
            dragging && "ring-1 ring-ring",
          )}
          onDragEnter={() => setDragging(true)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
        >
          {items.map((item, index) => (
            <LoadoutCard
              key={itemKey(item)}
              item={item}
              index={index}
              providers={providers}
              catalogs={catalogs}
              onRemove={() => commitItems(items.filter((candidate) => itemKey(candidate) !== itemKey(item)))}
              onEffort={(reasoningLevel) =>
                commitItems(
                  items.map((candidate) =>
                    itemKey(candidate) === itemKey(item)
                      ? { ...candidate, reasoningLevel }
                      : candidate,
                  ),
                )
              }
              onDrop={handleDrop}
            />
          ))}
          {Array.from({ length: MAX_LOADOUT - items.length }, (_, offset) => (
            <EmptyLoadoutSlot key={`empty-${offset}`} index={items.length + offset} onDrop={handleDrop} />
          ))}
        </div>
        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
      </section>

      <section className="space-y-3">
        <div className="relative max-w-sm">
          <Icon name="Search" className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search available models"
            aria-label="Search available models"
            className="pl-8"
          />
        </div>

        {providerStatus === "loading" || config === null ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Loading provider catalogs…
          </div>
        ) : (
          <div className="grid overflow-hidden rounded-lg border border-border bg-card md:grid-cols-2 xl:grid-cols-3">
            {providers.filter((provider) => provider.available).map((provider) => {
              const catalog = catalogs[provider.id];
              const models = (catalog?.models ?? []).filter((model) =>
                `${model.displayName} ${model.model}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
              );
              return (
                <div key={provider.id} className="min-w-0 border-b border-r border-border last:border-r-0">
                  <div className="flex items-center gap-2 border-b border-border bg-surface-recessed px-3 py-2.5 text-sm font-medium">
                    <ModelMark provider={provider} className="size-4" />
                    <span className="truncate">{provider.displayName}</span>
                  </div>
                  {catalog?.loading !== false ? (
                    <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
                  ) : catalog.error !== null ? (
                    <p className="px-3 py-3 text-xs text-destructive">{catalog.error}</p>
                  ) : models.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-muted-foreground">No matching models</p>
                  ) : (
                    models.map((model) => {
                      const key = itemKey({ providerId: provider.id, model: model.model });
                      const checked = selected.has(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData(
                              DRAG_TYPE,
                              JSON.stringify({ providerId: provider.id, model: model.model }),
                            );
                            setDragging(true);
                          }}
                          onDragEnd={() => setDragging(false)}
                          onClick={() =>
                            checked
                              ? commitItems(items.filter((item) => itemKey(item) !== key))
                              : add(provider.id, model)
                          }
                          disabled={!checked && items.length >= MAX_LOADOUT}
                          className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
                          {checked ? <Icon name="Check" className="size-4 shrink-0" aria-hidden /> : null}
                          <Icon name="DragDropVertical" className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
                        </button>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function mountNativeSelectorHider(generation: number) {
  const style = document.createElement("style");
  style.dataset.modelLoadoutStyle = String(generation);
  style.textContent = `
    [data-model-loadout-owner="${generation}"] > button[aria-label^="Provider, model and reasoning"],
    [data-model-loadout-owner="${generation}"] button[aria-label^="Provider, model and reasoning"] {
      display: none !important;
    }
    [data-model-loadout-popup-clip="${generation}"] {
      overflow: visible !important;
      position: relative;
      z-index: 40;
    }
    [data-model-loadout-popup-clip="${generation}"]:has(> [data-bb-plugin-root] > [data-model-loadout-popup]) {
      border-color: transparent !important;
      background: transparent !important;
      box-shadow: none !important;
    }
  `;
  document.head.append(style);

  let queued = false;
  const refresh = () => {
    queued = false;
    observer.disconnect();
    document
      .querySelectorAll(`[data-model-loadout-owner="${generation}"]`)
      .forEach((node) => node.removeAttribute("data-model-loadout-owner"));
    document
      .querySelectorAll(`[data-model-loadout-popup-clip="${generation}"]`)
      .forEach((node) => node.removeAttribute("data-model-loadout-popup-clip"));
    for (const trigger of Array.from(
      document.querySelectorAll<HTMLElement>("[data-model-loadout-trigger]"),
    )) {
      let owner = trigger.parentElement;
      while (owner !== null && owner !== document.body) {
        const native = owner.querySelector<HTMLButtonElement>(
          'button[aria-label^="Provider, model and reasoning"]',
        );
        if (native !== null && !native.hasAttribute("data-model-loadout-trigger")) {
          owner.dataset.modelLoadoutOwner = String(generation);
          break;
        }
        owner = owner.parentElement;
      }
    }
    for (const popup of Array.from(
      document.querySelectorAll<HTMLElement>("[data-model-loadout-popup]"),
    )) {
      let ancestor = popup.parentElement;
      for (let depth = 0; ancestor !== null && ancestor !== document.body && depth < 10; depth += 1) {
        const styles = getComputedStyle(ancestor);
        if (styles.overflow === "hidden" || styles.overflowY === "hidden") {
          ancestor.dataset.modelLoadoutPopupClip = String(generation);
        }
        ancestor = ancestor.parentElement;
      }
    }
    observer.observe(document.body, { childList: true, subtree: true });
  };
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(refresh);
  });
  refresh();
  return () => {
    observer.disconnect();
    style.remove();
    document
      .querySelectorAll(`[data-model-loadout-owner="${generation}"]`)
      .forEach((node) => node.removeAttribute("data-model-loadout-owner"));
    document
      .querySelectorAll(`[data-model-loadout-popup-clip="${generation}"]`)
      .forEach((node) => node.removeAttribute("data-model-loadout-popup-clip"));
  };
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "model-loadout-selector",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "selector", component: SelectorAction }],
    experimental_popups: [
      {
        id: "model-selector",
        label: "Choose agent and model",
        component: ModelSelectorPopup,
      },
    ],
  });

  for (let slot = 1; slot <= MAX_LOADOUT; slot += 1) {
    app.composer.experimental_registerCommand({
      id: `select-model-${slot}`,
      title: `Model Loadout: select model ${slot}`,
      defaultShortcut: { key: String(slot), mod: true, control: true },
      run: async ({ composer }) => {
        const item = latestItems[slot - 1];
        if (item === undefined) return;
        await composer.setSelection({
          providerId: item.providerId,
          model: item.model,
          reasoningLevel: item.reasoningLevel,
          ...(item.serviceTier === undefined ? {} : { serviceTier: item.serviceTier }),
        });
      },
    });
  }

  app.composer.experimental_registerCommand({
    id: "toggle-fast",
    title: "Model Loadout: toggle fast mode",
    defaultShortcut: { key: "f", alt: true },
    run: async ({ composer }) => {
      await composer.setSelection({
        serviceTier: composer.selection?.serviceTier === "fast" ? "default" : "fast",
      });
    },
  });

  app.slots.settingsSection({
    id: "default-models",
    component: DefaultModelsSettings,
  });

  app.contentScripts.register({
    id: "hide-native-model-selector",
    mount: ({ generation }) => mountNativeSelectorHider(generation),
  });
});
