/* Shared data layer, loaded by both the background page and the sidebar.
 *
 * storage.local (was storage.sync until 0.4: too small for big Arc imports;
 * old sync data is copied over once and left in place as a backup)
 *   favorites        [{id, url, title, icon}]          favorites of spaces without a container
 *   favorites@<cookieStoreId>                          favorites of spaces in that container
 *                    (like Arc profiles: spaces sharing a container share favorites)
 *   spaces           [{id, name, icon, color, container}]
 *   pins:<spaceId>   [{id, url, title, icon, parent?} | {id, type: "folder", name, open, parent?}]
 *                    pinned items + folders of one space, flat and ordered; an item's
 *                    `parent` is the id of the folder it's in
 *   Lists over the 8KB per-key quota continue in "<key>#1", "<key>#2", ...
 * storage.local
 *   faviconCache     {itemId: url}
 * session values (survive restarts)
 *   tab    arcfoxFav    id of the favorite / pinned item the tab belongs to
 *   tab    arcfoxSpace  space the tab lives in
 *   window arcfoxSpace  active space of the window
 *   window arcfoxLast   {spaceId: tabId} last active tab per space
 */
"use strict";

// eslint-disable-next-line no-unused-vars
const ArcFox = (() => {
  const FAV_KEY = "favorites";
  const SPACES_KEY = "spaces";
  const PIN_PREFIX = "pins:";
  const ICON_KEY = "faviconCache";
  const BADGES_KEY = "tabBadges"; // storage.session: { [extensionId]: [{ tabId, label, title, color }] }
  const BADGE_PROVIDERS_KEY = "badgeProviders"; // storage.local: extensions that have set badges or menu items
  const TAB_MENU_KEY = "tabMenus"; // storage.session: { [extensionId]: [{ id, title, tabIds, exceptTabIds }] }
  const VISITS_KEY = "visitsByContainer"; // storage.local: { [url]: { s: [cookieStoreId], t: lastVisit } }
  const MAX_VISITS = 4000;
  const ITEM_VALUE = "arcfoxFav"; // name kept so bindings from 0.1.x survive
  const SPACE_VALUE = "arcfoxSpace";
  const LAST_VALUE = "arcfoxLast";
  const PARENT_VALUE = "arcfoxParent"; // { itemId } | { tabId, rootUid? } for single-level child subtabs
  const LOCK_VALUE = "arcfoxLocked"; // { url, lockedOrder } for locked #today tabs
  const ROOT_ID_VALUE = "arcfoxRootId"; // stable string uid on #today parent tabs across session restore

  // Firefox container colors, reused for spaces so a space matches its container.
  const COLORS = {
    blue: "#37adff",
    turquoise: "#00c79a",
    green: "#51cd00",
    yellow: "#ffcb00",
    orange: "#ff9f00",
    red: "#ff613d",
    pink: "#ff4bda",
    purple: "#af51f5",
  };

  const DEFAULT_SPACE = { id: "default", name: "Personal", icon: "", color: "purple", container: null };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const isFavoritable = (url) => /^https?:\/\//i.test(url || "");
  /** Firefox's blank new tab, before Arc swaps it for the command bar. */
  const isFirefoxNewTab = (url) =>
    url === "about:newtab" || url === "about:home" || /^moz-extension:\/\/[^/]+\/newtab\//.test(url || "");

  // Firefox's new-tab pages, plus Arc's own (new-tab page, full-page command bar).
  const isNewTabUrl = (url) =>
    url === "about:newtab" || url === "about:home" || /^moz-extension:\/\/[^/]+\/(newtab|palette)\//.test(url || "");
  // Only short http(s) favicon URLs go to sync storage (8KB per-item quota).
  const syncableIcon = (url) => (url && /^https?:/i.test(url) && url.length < 512 ? url : "");
  const pinKey = (spaceId) => PIN_PREFIX + spaceId;
  /** Favorites list of a space: per container, like Arc's per-profile favorites. */
  const favKey = (space) => (space?.container ? `${FAV_KEY}@${space.container}` : FAV_KEY);
  const isFavKey = (key) => key === FAV_KEY || key.startsWith(`${FAV_KEY}@`);
  const spaceOfKey = (key) => (key.startsWith(PIN_PREFIX) ? key.slice(PIN_PREFIX.length) : null);

  const isFolder = (item) => item?.type === "folder";

  /** Strip #fragment and trailing slash so minor URL differences don't count as "away". */
  const normUrl = (u) => (u || "").replace(/#.*$/, "").replace(/^(https?:\/\/.+)\/$/, "$1");
  const sameUrl = (a, b) => normUrl(a) === normUrl(b);

  /**
   * Validate and normalize a user-edited saved URL. Accepts http(s) URLs or
   * bare host/path strings (which default to https://). Returns null if invalid.
   */
  function normalizeSavedUrl(raw) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed || /\s/.test(trimmed)) return null;
    let candidate = trimmed;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      if (!/^(localhost(?::\d+)?(?:\/|$)|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$|\?))/i.test(candidate)) {
        return null;
      }
      candidate = `https://${candidate}`;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (!parsed.hostname) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  /** True when an open tab has navigated away from its saved/locked URL. */
  function isTabAway(tab, savedUrl) {
    if (!tab || !savedUrl) return false;
    if (tab.status === "loading" && (!tab.url || tab.url === "about:blank")) return false;
    if (!tab.url || tab.url === "about:blank") return false;
    return !sameUrl(tab.url, savedUrl);
  }

  /**
   * Reorder a list of items/tabs so locked entries return to their `lockedOrder`
   * slot while unlocked entries fill the remaining slots in relative order.
   */
  function reorderByLockedOrder(list) {
    const locked = list
      .map((item, idx) => ({ item, idx, order: typeof item.lockedOrder === "number" ? item.lockedOrder : Infinity }))
      .filter((x) => x.item.locked)
      .sort((a, b) => a.order - b.order || a.idx - b.idx);
    if (!locked.length) return list.slice();
    const slots = new Array(list.length).fill(null);
    let prevSlot = -1;
    for (let i = 0; i < locked.length; i++) {
      const remainingAfter = locked.length - 1 - i;
      const maxAllowed = list.length - 1 - remainingAfter;
      const desired = Number.isFinite(locked[i].order)
        ? Math.max(0, Math.min(locked[i].order, list.length - 1))
        : Math.max(0, prevSlot + 1);
      const slot = Math.min(Math.max(desired, prevSlot + 1), maxAllowed);
      slots[slot] = locked[i].item;
      prevSlot = slot;
    }
    const unlocked = list.filter((item) => !item.locked);
    let u = 0;
    for (let s = 0; s < slots.length; s++) {
      if (slots[s] === null) slots[s] = unlocked[u++];
    }
    return slots;
  }

  /**
   * Assign `lockedOrder` to `list[targetIdx]` within its container and shift any
   * colliding subsequent locked entries.
   */
  function assignLockedOrder(list, targetIdx, insertedNewBlock = false) {
    if (targetIdx < 0 || targetIdx >= list.length) return 0;
    let maxOrderBefore = -1;
    for (let i = 0; i < targetIdx; i++) {
      if (list[i].locked && typeof list[i].lockedOrder === "number" && list[i].lockedOrder > maxOrderBefore) {
        maxOrderBefore = list[i].lockedOrder;
      }
    }
    const order = targetIdx > maxOrderBefore ? targetIdx : maxOrderBefore + 1;
    if (insertedNewBlock) {
      for (let i = targetIdx + 1; i < list.length; i++) {
        if (list[i].locked && (list[i].lockedOrder ?? -1) >= order) {
          list[i].lockedOrder = (list[i].lockedOrder ?? order) + 1;
        }
      }
    } else {
      let nextCollision = order;
      const afterLocked = list
        .slice(targetIdx + 1)
        .filter((x) => x.locked)
        .sort((a, b) => (a.lockedOrder ?? Infinity) - (b.lockedOrder ?? Infinity));
      for (const other of afterLocked) {
        if ((other.lockedOrder ?? -1) === nextCollision) {
          nextCollision += 1;
          other.lockedOrder = nextCollision;
        }
      }
    }
    list[targetIdx].locked = true;
    list[targetIdx].lockedOrder = order;
    return order;
  }

  /**
   * Restore locked pinned items to their `lockedOrder` within the top-level
   * pinned list and within each folder, keeping folders at their positions.
   */
  function reorderPinListByLockedOrder(pins) {
    const topItems = pins.filter((i) => !isFolder(i) && !i.parent);
    const reorderedTop = reorderByLockedOrder(topItems);
    const byFolder = new Map();
    for (const item of pins) {
      if (isFolder(item)) {
        const children = pins.filter((c) => !isFolder(c) && c.parent === item.id);
        byFolder.set(item.id, reorderByLockedOrder(children));
      }
    }
    const out = [];
    let topIdx = 0;
    for (const item of pins) {
      if (isFolder(item)) {
        out.push(item, ...(byFolder.get(item.id) || []));
      } else if (!item.parent) {
        out.push(reorderedTop[topIdx++]);
      }
    }
    return out;
  }

  function insertBefore(list, item, beforeId) {
    const at = beforeId ? list.findIndex((i) => i.id === beforeId) : -1;
    if (at >= 0) list.splice(at, 0, item);
    else list.push(item);
  }

  /** Insert before `beforeId`, else at the end of folder `parent`, else at the end. */
  function insertInto(list, item, beforeId, parent) {
    if (beforeId || !parent) return insertBefore(list, item, beforeId);
    let at = -1;
    list.forEach((x, i) => {
      if (x.id === parent || x.parent === parent) at = i;
    });
    list.splice(at + 1, 0, item);
  }

  function notify() {
    browser.runtime.sendMessage({ type: "arcfox:changed" }).catch(() => {});
  }

  /* ---------- Storage ---------- */

  const DATA = browser.storage.local;
  // Lists are split across numbered keys (a leftover from storage.sync's 8KB
  // per-key limit; harmless in local storage and keeps the format stable).
  const CHUNK_BYTES = 7000;

  function readList(all, key) {
    const list = Array.isArray(all[key]) ? [...all[key]] : [];
    for (let i = 1; Array.isArray(all[`${key}#${i}`]); i++) list.push(...all[`${key}#${i}`]);
    return list;
  }

  /** Write lists ({key: list}) in chunks and drop chunks no longer needed. */
  async function writeLists(entries) {
    stateCache = null;
    const existing = Object.keys(await DATA.get(null));
    const set = {};
    const remove = [];
    for (const [key, list] of Object.entries(entries)) {
      const chunks = [[]];
      let size = 2;
      for (const item of list) {
        const n = JSON.stringify(item).length + 1;
        if (size + n > CHUNK_BYTES && chunks.at(-1).length) {
          chunks.push([]);
          size = 2;
        }
        chunks.at(-1).push(item);
        size += n;
      }
      chunks.forEach((chunk, i) => (set[i ? `${key}#${i}` : key] = chunk));
      for (const k of existing) {
        const n = k.startsWith(`${key}#`) ? Number(k.slice(key.length + 1)) : 0;
        if (n >= chunks.length) remove.push(k);
      }
    }
    await DATA.set(set);
    if (remove.length) await DATA.remove(remove);
  }

  const writeList = (key, list) => writeLists({ [key]: list });

  // Reading every key and rebuilding the state is the sidebar's hot path (it
  // refreshes on each tab event), so keep the last result until something
  // changes. storage.onChanged fires in this context too, including for our
  // own writes.
  let stateCache = null;
  let iconCache = null;
  let visitCache = null;

  browser.storage.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    for (const key of Object.keys(changes)) {
      if (key === ICON_KEY) iconCache = null;
      if (key === VISITS_KEY) visitCache = null;
      else if (key === SPACES_KEY || key.startsWith(FAV_KEY) || key.startsWith(PIN_PREFIX)) stateCache = null;
    }
  });

  async function getState() {
    if (stateCache) return stateCache;
    let all = await DATA.get(null);
    if (!(SPACES_KEY in all)) {
      // One-time move from storage.sync (Arc before 0.4).
      const old = await browser.storage.sync.get(null).catch(() => ({}));
      const keep = Object.fromEntries(
        Object.entries(old).filter(([k]) => k === SPACES_KEY || k.startsWith(FAV_KEY) || k.startsWith(PIN_PREFIX))
      );
      if (keep[SPACES_KEY]) {
        await DATA.set(keep);
        all = await DATA.get(null);
      }
    }
    let spaces = Array.isArray(all[SPACES_KEY]) && all[SPACES_KEY].length ? all[SPACES_KEY] : null;
    if (!spaces) {
      // Fixed id, so concurrent first runs (background + sidebar) agree.
      spaces = [{ ...DEFAULT_SPACE }];
      stateCache = null;
    await DATA.set({ [SPACES_KEY]: spaces });
    }
    const pins = new Map(spaces.map((s) => [s.id, readList(all, pinKey(s.id))]));
    const favLists = new Map([[FAV_KEY, readList(all, FAV_KEY)]]);
    for (const key of Object.keys(all)) {
      if (key.startsWith(`${FAV_KEY}@`) && !key.includes("#")) favLists.set(key, readList(all, key));
    }
    // `favorites`: every favorite in every list (for "is this a favorite?" checks).
    const favorites = [...favLists.values()].flat();
    stateCache = { favorites, favLists, spaces, pins };
    return stateCache;
  }

  function listFor(state, key) {
    if (isFavKey(key)) return state.favLists?.get(key) || (key === FAV_KEY ? state.favorites : []);
    return state.pins.get(spaceOfKey(key)) || [];
  }

  function findItem(state, itemId) {
    for (const [key, list] of state.favLists || [[FAV_KEY, state.favorites]]) {
      const fav = list.find((f) => f.id === itemId);
      if (fav) return { key, spaceId: null, list, item: fav };
    }
    for (const [spaceId, list] of state.pins) {
      const item = list.find((i) => i.id === itemId);
      if (item) return { key: pinKey(spaceId), spaceId, list, item };
    }
    return null;
  }

  const allItemIds = (state) =>
    new Set([...state.favorites, ...[...state.pins.values()].flat()].map((i) => i.id));

  async function getIconCache() {
    if (iconCache) return iconCache;
    const { [ICON_KEY]: cache } = await browser.storage.local.get(ICON_KEY);
    iconCache = cache && typeof cache === "object" ? cache : {};
    return iconCache;
  }

  async function cacheIcon(itemId, url) {
    if (!url || !/^(https?:|data:image\/)/i.test(url)) return;
    const cache = await getIconCache();
    if (cache[itemId] === url) return;
    cache[itemId] = url;
    iconCache = null;
    await browser.storage.local.set({ [ICON_KEY]: cache });
  }

  async function dropIcon(itemId) {
    const cache = await getIconCache();
    if (!(itemId in cache)) return;
    delete cache[itemId];
    iconCache = null;
    await browser.storage.local.set({ [ICON_KEY]: cache });
  }

  /* ---------- Session values ---------- */

  // Every sessions.getTabValue is a round trip to the parent process, and a
  // scan asks for two per tab: with a few hundred tabs that is by far the
  // slowest thing the sidebar does, and it scans on most tab events. The
  // values only change when Arc writes one, so remember what was read. Only
  // answers are kept — a tab with no space yet is given one a moment later,
  // and that must not be cached as "none".
  const tabValues = new Map(); // `${tabId}:${key}` -> value

  const OPTIONAL_TAB_VALUES = new Set([PARENT_VALUE, LOCK_VALUE, ROOT_ID_VALUE]);

  async function tabValue(tabId, key) {
    const cacheId = `${tabId}:${key}`;
    if (tabValues.has(cacheId)) return tabValues.get(cacheId);
    let value;
    try {
      value = await browser.sessions.getTabValue(tabId, key);
    } catch {
      return undefined; // tab already gone
    }
    if (value !== undefined && value !== null) {
      tabValues.set(cacheId, value);
    } else if (
      OPTIONAL_TAB_VALUES.has(key) &&
      (tabValues.has(`${tabId}:${SPACE_VALUE}`) || tabValues.has(`${tabId}:${ITEM_VALUE}`))
    ) {
      tabValues.set(cacheId, undefined);
    }
    return value;
  }

  /** Record a value this context just wrote, and tell the others to re-read. */
  function noteTabValue(tabId, key, value) {
    const cacheId = `${tabId}:${key}`;
    if (value === undefined || value === null) {
      if (
        OPTIONAL_TAB_VALUES.has(key) &&
        (tabValues.has(`${tabId}:${SPACE_VALUE}`) || tabValues.has(`${tabId}:${ITEM_VALUE}`))
      ) {
        tabValues.set(cacheId, undefined);
      } else {
        tabValues.delete(cacheId);
      }
    } else {
      tabValues.set(cacheId, value);
    }
    // Arc runs in several contexts (background, each sidebar); each caches on
    // its own, so a write has to reach the rest. Senders don't get their own
    // message, and nobody listening is fine.
    browser.runtime.sendMessage({ type: "arcsidebar:tab-value", tabId, key }).catch(() => {});
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "arcsidebar:tab-value") tabValues.delete(`${msg.tabId}:${msg.key}`);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabValues.delete(`${tabId}:${ITEM_VALUE}`);
    tabValues.delete(`${tabId}:${SPACE_VALUE}`);
    tabValues.delete(`${tabId}:${PARENT_VALUE}`);
    tabValues.delete(`${tabId}:${LOCK_VALUE}`);
    tabValues.delete(`${tabId}:${ROOT_ID_VALUE}`);
  });

  async function windowValue(windowId, key) {
    try {
      return await browser.sessions.getWindowValue(windowId, key);
    } catch {
      return undefined;
    }
  }

  const getTabItem = (tabId) => tabValue(tabId, ITEM_VALUE);
  const getTabSpace = (tabId) => tabValue(tabId, SPACE_VALUE);
  const getTabParentRaw = (tabId) => tabValue(tabId, PARENT_VALUE);
  const getTabParent = async (tabId) => {
    const p = await getTabParentRaw(tabId);
    if (!p) return undefined;
    if (p.itemId) return { itemId: p.itemId };
    if (p.tabId) return { tabId: p.tabId };
    return undefined;
  };
  const getTabLocked = (tabId) => tabValue(tabId, LOCK_VALUE);
  const getTabRootUid = (tabId) => tabValue(tabId, ROOT_ID_VALUE);
  // A tab can be gone by the time it is marked (closed by hand, or taken for
  // something else), and that is no reason to fail whatever opened it.
  const setTabItem = async (tabId, itemId) => {
    try {
      await browser.sessions.setTabValue(tabId, ITEM_VALUE, itemId);
      noteTabValue(tabId, ITEM_VALUE, itemId);
    } catch {
      // tab already gone
    }
  };
  const setTabSpace = async (tabId, spaceId) => {
    try {
      await browser.sessions.setTabValue(tabId, SPACE_VALUE, spaceId);
      noteTabValue(tabId, SPACE_VALUE, spaceId);
    } catch {
      // tab already gone
    }
  };
  const rootUidInflight = new Map();

  const ensureTabRootUid = async (tabId, preferredUid = undefined) => {
    const existing = await getTabRootUid(tabId);
    if (typeof existing === "string" && existing) return existing;
    if (rootUidInflight.has(tabId)) return rootUidInflight.get(tabId);
    const promise = (async () => {
      const next = typeof preferredUid === "string" && preferredUid ? preferredUid : uid();
      tabValues.set(`${tabId}:${ROOT_ID_VALUE}`, next);
      try {
        await browser.sessions.setTabValue(tabId, ROOT_ID_VALUE, next);
        noteTabValue(tabId, ROOT_ID_VALUE, next);
        return next;
      } catch {
        tabValues.delete(`${tabId}:${ROOT_ID_VALUE}`);
        return undefined;
      } finally {
        rootUidInflight.delete(tabId);
      }
    })();
    rootUidInflight.set(tabId, promise);
    return promise;
  };
  const clearTabRootUid = async (tabId) => {
    try {
      await browser.sessions.removeTabValue(tabId, ROOT_ID_VALUE);
      noteTabValue(tabId, ROOT_ID_VALUE, null);
    } catch {
      // tab already gone
    }
  };
  const setTabParent = async (tabId, parent) => {
    if (!parent || (!parent.itemId && !parent.tabId)) return clearTabParent(tabId);
    let normalized = parent;
    if (parent.tabId && !parent.rootUid) {
      const rootUid = await ensureTabRootUid(parent.tabId);
      if (rootUid) normalized = { ...parent, rootUid };
    }
    try {
      await browser.sessions.setTabValue(tabId, PARENT_VALUE, normalized);
      noteTabValue(tabId, PARENT_VALUE, normalized);
    } catch {
      // tab already gone
    }
  };
  const clearTabParent = async (tabId) => {
    try {
      await browser.sessions.removeTabValue(tabId, PARENT_VALUE);
      noteTabValue(tabId, PARENT_VALUE, null);
    } catch {
      // tab already gone
    }
  };
  const setTabLockedValue = async (tabId, lock) => {
    if (!lock || !lock.url) return clearTabLockedValue(tabId);
    try {
      await browser.sessions.setTabValue(tabId, LOCK_VALUE, lock);
      noteTabValue(tabId, LOCK_VALUE, lock);
    } catch {
      // tab already gone
    }
  };
  const clearTabLockedValue = async (tabId) => {
    try {
      await browser.sessions.removeTabValue(tabId, LOCK_VALUE);
      noteTabValue(tabId, LOCK_VALUE, null);
    } catch {
      // tab already gone
    }
  };

  async function clearTabItem(tabId) {
    try {
      await browser.sessions.removeTabValue(tabId, ITEM_VALUE);
      noteTabValue(tabId, ITEM_VALUE, null);
    } catch {
      // tab already gone
    }
  }

  /**
   * Read item bindings, spaces, single-level parent links, and lock metadata
   * for the given tabs.
   * Duplicated tabs inherit session values: the oldest binding wins, the rest
   * are released. Bindings to deleted items are released too.
   * Single-level child subtabs self-heal here: if a parent tab closed, its
   * first surviving child is promoted to root and remaining siblings repoint
   * to that promoted child.
   */
  async function scanTabs(tabs, state) {
    const known = allItemIds(state);
    const pinItemSpace = new Map();
    for (const [spId, list] of state.pins.entries()) {
      for (const item of list) {
        if (!isFolder(item)) pinItemSpace.set(item.id, spId);
      }
    }
    const metas = await Promise.all(
      tabs.map(async (t) => [
        t,
        ...(await Promise.all([
          getTabItem(t.id),
          getTabSpace(t.id),
          getTabParentRaw(t.id),
          getTabLocked(t.id),
          getTabRootUid(t.id),
        ])),
      ])
    );
    metas.sort((a, b) => a[0].id - b[0].id);
    const bound = new Map(); // itemId -> tab
    const tabItem = new Map(); // tabId -> itemId
    const tabSpace = new Map(); // tabId -> spaceId
    const rawParent = new Map(); // tabId -> { itemId?, tabId?, rootUid? }
    const tabLocked = new Map(); // tabId -> { url, lockedOrder }
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const byRootUid = new Map(); // rootUid -> tab
    const tabRootUid = new Map(); // tabId -> rootUid

    for (const [tab, itemId, spaceId, parentVal, lockVal, rootUidVal] of metas) {
      if (spaceId) tabSpace.set(tab.id, spaceId);
      if (parentVal && (parentVal.itemId || parentVal.tabId)) rawParent.set(tab.id, parentVal);
      if (typeof rootUidVal === "string" && rootUidVal) {
        if (byRootUid.has(rootUidVal)) {
          clearTabRootUid(tab.id);
          if (!rawParent.has(tab.id) && !itemId) {
            const orig = byRootUid.get(rootUidVal);
            const p = { tabId: orig.id, rootUid: rootUidVal };
            rawParent.set(tab.id, p);
            setTabParent(tab.id, p);
          }
        } else {
          byRootUid.set(rootUidVal, tab);
          tabRootUid.set(tab.id, rootUidVal);
        }
      }
      if (itemId) {
        if (!known.has(itemId) || bound.has(itemId)) {
          clearTabItem(tab.id);
          // A duplicated pinned tab inherits ITEM_VALUE: make the duplicate a child subtab of the original item.
          if (known.has(itemId) && pinItemSpace.has(itemId) && !rawParent.has(tab.id)) {
            const p = { itemId };
            rawParent.set(tab.id, p);
            setTabParent(tab.id, p);
          }
        } else {
          bound.set(itemId, tab);
          tabItem.set(tab.id, itemId);
        }
      }
      if (lockVal && typeof lockVal.url === "string") {
        if (tabItem.has(tab.id)) {
          clearTabLockedValue(tab.id);
        } else {
          tabLocked.set(tab.id, {
            url: lockVal.url,
            lockedOrder: typeof lockVal.lockedOrder === "number" ? lockVal.lockedOrder : 0,
          });
        }
      }
      if (spaceId || tabItem.has(tab.id)) {
        if (!rawParent.has(tab.id)) tabValues.set(`${tab.id}:${PARENT_VALUE}`, undefined);
        if (!tabLocked.has(tab.id)) tabValues.set(`${tab.id}:${LOCK_VALUE}`, undefined);
        if (!tabRootUid.has(tab.id)) tabValues.set(`${tab.id}:${ROOT_ID_VALUE}`, undefined);
      }
    }

    // Reconcile parent tabIds against rootUid (handles Firefox numeric tab.id
    // reassignment on session restore and guards against tab.id reuse).
    for (const [childId, p] of rawParent) {
      if (!p.tabId || !p.rootUid) continue;
      const byUid = byRootUid.get(p.rootUid);
      if (byUid && byUid.id !== p.tabId) {
        const reconciled = { tabId: byUid.id, rootUid: p.rootUid };
        rawParent.set(childId, reconciled);
        await setTabParent(childId, reconciled);
      }
    }

    const matchesParentRootUid = (candidateId, expectedRootUid, extRootUid = undefined) => {
      if (!expectedRootUid) return true;
      const actual = tabRootUid.get(candidateId) ?? extRootUid;
      return actual === expectedRootUid;
    };

    // Check whether any parent tab missing from `tabs` (e.g. during a partial
    // single-window scan) is actually still open before treating it as closed.
    const missingParentIds = new Set();
    for (const p of rawParent.values()) {
      if (p.tabId && !byId.has(p.tabId)) missingParentIds.add(p.tabId);
    }
    const externalParents = new Map();
    await Promise.all(
      [...missingParentIds].map(async (id) => {
        const live = await browser.tabs.get(id).catch(() => null);
        if (live) {
          const [extItem, extSpace, extParent, extRootUid] = await Promise.all([
            getTabItem(id),
            getTabSpace(id),
            getTabParentRaw(id),
            getTabRootUid(id),
          ]);
          externalParents.set(id, {
            tab: live,
            itemId: extItem,
            spaceId: extSpace,
            parent: extParent,
            rootUid: extRootUid,
          });
        }
      })
    );

    const resolveLiveParentTab = (p) => {
      if (!p?.tabId) return null;
      const inScan = byId.get(p.tabId);
      if (inScan && matchesParentRootUid(p.tabId, p.rootUid)) return inScan;
      const ext = externalParents.get(p.tabId);
      if (ext?.tab && matchesParentRootUid(p.tabId, p.rootUid, ext.rootUid)) return ext.tab;
      return null;
    };

    // If a #today parent tab was closed, promote its first surviving child to
    // root and repoint remaining sibling children to that promoted child.
    const orphansByMissingParent = new Map();
    for (const [childId, p] of rawParent) {
      if (p.tabId && !resolveLiveParentTab(p)) {
        const key = p.rootUid || p.tabId;
        const list = orphansByMissingParent.get(key) || [];
        list.push(byId.get(childId));
        orphansByMissingParent.set(key, list);
      }
    }
    for (const orphans of orphansByMissingParent.values()) {
      orphans.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.id - b.id);
      const [first, ...rest] = orphans;
      rawParent.delete(first.id);
      await clearTabParent(first.id);
      if (rest.length) {
        const firstRootUid = tabRootUid.get(first.id) || (await ensureTabRootUid(first.id));
        if (firstRootUid) {
          tabRootUid.set(first.id, firstRootUid);
          byRootUid.set(firstRootUid, first);
        }
        for (const sib of rest) {
          const nextParent = firstRootUid ? { tabId: first.id, rootUid: firstRootUid } : { tabId: first.id };
          rawParent.set(sib.id, nextParent);
          await setTabParent(sib.id, nextParent);
        }
      }
    }

    const tabParent = new Map(); // tabId -> { itemId? | tabId?, rootUid? }
    const childrenByItem = new Map(); // itemId -> tab[]
    const childrenByTab = new Map(); // parentTabId -> tab[]

    for (const tab of tabs) {
      const p = rawParent.get(tab.id);
      if (!p) continue;
      const inSplit = tab.splitViewId !== undefined && tab.splitViewId !== -1;
      if (tabItem.has(tab.id) || tabLocked.has(tab.id) || inSplit) {
        clearTabParent(tab.id);
        continue;
      }
      // Enforce single-level nesting: walk up to the root parent.
      let root = p;
      let hops = 0;
      const seen = new Set([tab.id]);
      while (root?.tabId && hops < 10) {
        if (seen.has(root.tabId)) {
          root = null;
          break;
        }
        seen.add(root.tabId);
        const nextParent = rawParent.get(root.tabId) || externalParents.get(root.tabId)?.parent;
        if (!nextParent || (!nextParent.itemId && !nextParent.tabId)) break;
        root = nextParent;
        hops += 1;
      }
      if (!root) {
        clearTabParent(tab.id);
        continue;
      }
      const rootBoundItem =
        root.tabId && (tabItem.get(root.tabId) || externalParents.get(root.tabId)?.itemId || null);
      if (root.tabId && rootBoundItem) {
        if (!pinItemSpace.has(rootBoundItem)) {
          clearTabParent(tab.id);
          continue;
        }
        root = { itemId: rootBoundItem };
      }
      if (root.itemId) {
        const parentSpace = pinItemSpace.get(root.itemId);
        const childSpace = tabSpace.get(tab.id);
        if (!parentSpace || (childSpace && childSpace !== parentSpace)) {
          clearTabParent(tab.id);
          continue;
        }
        if (!childSpace) {
          tabSpace.set(tab.id, parentSpace);
          setTabSpace(tab.id, parentSpace);
        }
        const normalized = { itemId: root.itemId };
        if (p.itemId !== normalized.itemId || p.tabId !== undefined) setTabParent(tab.id, normalized);
        tabParent.set(tab.id, normalized);
        const list = childrenByItem.get(normalized.itemId) || [];
        list.push(tab);
        childrenByItem.set(normalized.itemId, list);
      } else if (root.tabId) {
        const parentTab = resolveLiveParentTab(root);
        const parentSpace = tabSpace.get(root.tabId) || externalParents.get(root.tabId)?.spaceId || null;
        const childSpace = tabSpace.get(tab.id) || null;
        if (
          root.tabId === tab.id ||
          !parentTab ||
          parentTab.windowId !== tab.windowId ||
          (parentSpace && childSpace && parentSpace !== childSpace)
        ) {
          clearTabParent(tab.id);
          continue;
        }
        const rootUid = root.rootUid || tabRootUid.get(root.tabId) || externalParents.get(root.tabId)?.rootUid;
        const stored = rootUid ? { tabId: root.tabId, rootUid } : { tabId: root.tabId };
        if (p.tabId !== stored.tabId || p.itemId !== undefined || (rootUid && p.rootUid !== rootUid)) {
          setTabParent(tab.id, stored);
        }
        const normalized = { tabId: root.tabId };
        tabParent.set(tab.id, normalized);
        const list = childrenByTab.get(normalized.tabId) || [];
        list.push(tab);
        childrenByTab.set(normalized.tabId, list);
      }
    }

    for (const list of childrenByItem.values()) list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.id - b.id);
    for (const list of childrenByTab.values()) list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.id - b.id);

    return { bound, tabItem, tabSpace, tabParent, tabLocked, childrenByItem, childrenByTab };
  }

  async function findBoundTab(state, itemId) {
    return (await scanTabs(await browser.tabs.query({}), state)).bound.get(itemId) || null;
  }

  /* ---------- Spaces & windows ---------- */

  async function getWindowSpace(windowId, state) {
    const id = await windowValue(windowId, SPACE_VALUE);
    return state.spaces.some((s) => s.id === id) ? id : state.spaces[0].id;
  }

  async function rememberActive(windowId, spaceId, tabId) {
    const last = (await windowValue(windowId, LAST_VALUE)) || {};
    if (last[spaceId] === tabId) return;
    last[spaceId] = tabId;
    await browser.sessions.setWindowValue(windowId, LAST_VALUE, last);
  }

  /**
   * Where a new tab goes in a space: above that space's other tabs (Arc puts
   * new tabs at the top), after any natively pinned ones.
   */
  async function topIndexOfSpace(windowId, spaceId, { ignoreTabId = null } = {}) {
    const tabs = (await browser.tabs.query({ windowId })).filter((t) => t.id !== ignoreTabId);
    const pinned = tabs.filter((t) => t.pinned).length;
    const state = await getState();
    const { tabItem, tabSpace } = await scanTabs(tabs, state);
    const favIds = new Set(state.favorites.map((f) => f.id));
    const mine = tabs.filter(
      (t) => !t.pinned && !favIds.has(tabItem.get(t.id)) && (tabSpace.get(t.id) ?? spaceId) === spaceId
    );
    return mine.length ? Math.max(pinned, Math.min(...mine.map((t) => t.index))) : pinned;
  }

  async function createTabInSpace(windowId, space, { url, active = true, index } = {}) {
    const opts = { windowId, active };
    if (url) opts.url = url;
    if (index !== undefined) opts.index = index;
    if (space.container) opts.cookieStoreId = space.container;
    let tab;
    try {
      tab = await browser.tabs.create(opts);
    } catch (err) {
      if (!opts.cookieStoreId) throw err;
      delete opts.cookieStoreId; // container was deleted
      tab = await browser.tabs.create(opts);
    }
    await setTabSpace(tab.id, space.id);
    return tab;
  }

  /** Split a window's tabs into the ones visible in `spaceId` and the rest. */
  async function computeVisibility(windowId, state, spaceId) {
    const tabs = await browser.tabs.query({ windowId });
    const { tabItem, tabSpace } = await scanTabs(tabs, state);
    const favIds = new Set(state.favorites.map((f) => f.id));
    const spaceIds = new Set(state.spaces.map((s) => s.id));
    const mine = []; // tabs of the space (not favorites)
    const show = [];
    const hide = [];
    for (const t of tabs) {
      if (favIds.has(tabItem.get(t.id))) {
        show.push(t.id);
        continue;
      }
      const s = tabSpace.get(t.id);
      if (!s || !spaceIds.has(s) || s === spaceId) {
        mine.push(t);
        show.push(t.id);
      } else {
        hide.push(t.id);
      }
    }
    return { tabs, mine, show, hide };
  }

  async function switchSpace(windowId, spaceId) {
    const state = await getState();
    const space = state.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    // Set first so the background's onActivated sees the new space.
    await browser.sessions.setWindowValue(windowId, SPACE_VALUE, spaceId);
    const { mine, show, hide } = await computeVisibility(windowId, state, spaceId);
    const last = (await windowValue(windowId, LAST_VALUE)) || {};
    let target =
      mine.find((t) => t.id === last[spaceId]) ||
      mine.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (show.length) await browser.tabs.show(show);
    if (target) await browser.tabs.update(target.id, { active: true });
    else target = await createTabInSpace(windowId, space);
    const toHide = hide.filter((id) => id !== target.id);
    if (toHide.length) await browser.tabs.hide(toHide).catch(() => {});
    notify();
  }

  /** Re-apply hidden/shown state, following the active tab if it lives in another space. */
  async function syncVisibility(windowId) {
    const state = await getState();
    let spaceId = await getWindowSpace(windowId, state);
    const [active] = await browser.tabs.query({ windowId, active: true });
    if (active) {
      const s = await getTabSpace(active.id);
      const itemId = await getTabItem(active.id);
      const isFav = state.favorites.some((f) => f.id === itemId);
      if (s && s !== spaceId && !isFav && state.spaces.some((x) => x.id === s)) {
        spaceId = s;
        await browser.sessions.setWindowValue(windowId, SPACE_VALUE, spaceId);
      }
    }
    const { show, hide } = await computeVisibility(windowId, state, spaceId);
    if (show.length) await browser.tabs.show(show);
    const toHide = hide.filter((id) => id !== active?.id);
    if (toHide.length) await browser.tabs.hide(toHide).catch(() => {});
    notify();
  }

  /**
   * Give the space's container the space's name and color, so Firefox's "Open
   * in container" menus and the tab stripe read the same as Arc's footer. Only
   * containers Arc made (ownContainer) are touched: a container the user keeps
   * for their own reasons isn't Arc's to rename.
   */
  async function syncContainer(space) {
    if (!space?.container || !space.ownContainer) return;
    const identity = await browser.contextualIdentities.get(space.container).catch(() => null);
    if (!identity) return;
    const color = COLORS[space.color] ? space.color : identity.color; // same palette as Firefox's
    if (identity.name === space.name && identity.color === color) return;
    await browser.contextualIdentities.update(space.container, { name: space.name, color }).catch(() => {});
  }

  async function saveSpace(space) {
    const state = await getState();
    const spaces = state.spaces.slice();
    const at = space.id ? spaces.findIndex((s) => s.id === space.id) : -1;
    let saved;
    if (at >= 0) spaces[at] = saved = { ...spaces[at], ...space };
    else spaces.push((saved = { ...space, id: uid() }));
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: spaces });
    await syncContainer(saved);
    notify();
    return saved;
  }

  /**
   * Spaces imported before Arc tracked which containers are its own: a
   * container Arc made carries the fingerprint icon, and is only reachable
   * here because a space points at it.
   */
  async function adoptArcContainers() {
    const state = await getState();
    const spaces = state.spaces.slice();
    let changed = false;
    for (const [i, space] of spaces.entries()) {
      if (!space.container || space.ownContainer !== undefined) continue;
      const identity = await browser.contextualIdentities.get(space.container).catch(() => null);
      spaces[i] = { ...space, ownContainer: identity?.icon === "fingerprint" };
      changed = true;
    }
    if (!changed) return;
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: spaces });
    for (const space of spaces) await syncContainer(space);
    notify();
  }

  async function moveSpace(spaceId, beforeSpaceId) {
    if (spaceId === beforeSpaceId) return;
    const state = await getState();
    const spaces = state.spaces.filter((s) => s.id !== spaceId);
    const space = state.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    insertBefore(spaces, space, beforeSpaceId);
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: spaces });
    notify();
  }

  /** Tabs (all windows) that live in a space, excluding favorites. */
  async function spaceTabs(spaceId) {
    const state = await getState();
    const tabs = await browser.tabs.query({});
    const { tabItem, tabSpace } = await scanTabs(tabs, state);
    const favIds = new Set(state.favorites.map((f) => f.id));
    return tabs.filter((t) => tabSpace.get(t.id) === spaceId && !favIds.has(tabItem.get(t.id)));
  }

  /** Delete a space and close its tabs. The last space cannot be deleted. */
  async function deleteSpace(spaceId) {
    const state = await getState();
    const rest = state.spaces.filter((s) => s.id !== spaceId);
    if (!rest.length || rest.length === state.spaces.length) return false;
    const doomed = (await spaceTabs(spaceId)).map((t) => t.id);
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: rest });
    await writeList(pinKey(spaceId), []);
    stateCache = null;
    await DATA.remove(pinKey(spaceId));
    for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
      if ((await windowValue(win.id, SPACE_VALUE)) === spaceId) await switchSpace(win.id, rest[0].id);
    }
    if (doomed.length) {
      markClosing(doomed);
      await browser.tabs.remove(doomed);
    }
    notify();
    return true;
  }

  /* Tabs Arc closes itself. Closing the tab you're on normally sends you back
     to the one before it (background.js), but a tab Arc swaps or tidies away
     has already been replaced by the one Arc wants you on. */
  const closing = new Set();

  function markClosingLocal(ids) {
    for (const id of [].concat(ids)) {
      closing.add(id);
      setTimeout(() => closing.delete(id), 5000)?.unref?.();
    }
  }

  function markClosing(ids) {
    const list = [].concat(ids);
    markClosingLocal(list);
    return browser.runtime?.sendMessage?.({ type: "arcfox:mark-closing", ids: list })?.catch?.(() => {});
  }

  browser.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.type === "arcfox:mark-closing" && Array.isArray(msg.ids)) {
      markClosingLocal(msg.ids);
      return Promise.resolve({ ok: true });
    }
  });

  /** True once, for a tab Arc marked: the answer is consumed with the tab. */
  function takeClosing(id) {
    return closing.delete(id);
  }

  /** Move a tab to another space. Reopens it when the space uses a different container. */
  async function moveTabToSpace(tabId, spaceId) {
    const state = await getState();
    const space = state.spaces.find((s) => s.id === spaceId);
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!space || !tab) return;
    const itemId = await getTabItem(tabId);
    const found = itemId && findItem(state, itemId);
    let moved = tabId;
    if (found) {
      if (isFavKey(found.key)) return; // favorites belong to a container, not a space
      await moveItem(itemId, pinKey(spaceId));
    } else {
      const winTabs = await browser.tabs.query({ windowId: tab.windowId });
      const scanned = await scanTabs(winTabs, state);
      const children = scanned.childrenByTab.get(tabId) || [];
      const priorLock = scanned.tabLocked.get(tabId) || null;
      const oldSpaceId = scanned.tabSpace.get(tabId) || null;
      if (scanned.tabParent.has(tabId)) {
        await clearTabParent(tabId);
      }
      if (
        space.container &&
        tab.cookieStoreId !== space.container &&
        (isFavoritable(tab.url) || isNewTabUrl(tab.url))
      ) {
        // A different container means the tab is reopened there.
        const replacement = await createTabInSpace(tab.windowId, space, {
          url: isFavoritable(tab.url) ? tab.url : undefined,
          active: false,
          index: tab.index + 1,
        });
        moved = replacement.id;
        await markClosing(tabId);
        await browser.tabs.remove(tabId);
        for (const child of children) {
          if (child.cookieStoreId === space.container) {
            await setTabParent(child.id, { tabId: moved });
            await setTabSpace(child.id, spaceId);
          } else {
            await clearTabParent(child.id);
          }
        }
      } else {
        await setTabSpace(tabId, spaceId);
        for (const child of children) {
          await setTabSpace(child.id, spaceId);
        }
      }
      if (priorLock) {
        let lockedOrder = priorLock.lockedOrder;
        if (oldSpaceId !== spaceId) {
          const destRootEntries = winTabs
            .filter(
              (t) =>
                t.id !== tabId &&
                !scanned.tabItem.has(t.id) &&
                !scanned.tabParent.has(t.id) &&
                scanned.tabSpace.get(t.id) === spaceId
            )
            .map((t) => {
              const l = scanned.tabLocked.get(t.id);
              return { id: t.id, index: t.index, locked: !!l, lockedOrder: l?.lockedOrder };
            });
          const movedEntry = { id: moved, index: tab.index, locked: true, lockedOrder: 0 };
          destRootEntries.push(movedEntry);
          destRootEntries.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          assignLockedOrder(destRootEntries, destRootEntries.indexOf(movedEntry), true);
          lockedOrder = movedEntry.lockedOrder;
          for (const entry of destRootEntries) {
            if (entry.id !== moved && entry.locked) {
              const prev = scanned.tabLocked.get(entry.id);
              if (prev && prev.lockedOrder !== entry.lockedOrder) {
                await setTabLockedValue(entry.id, { ...prev, lockedOrder: entry.lockedOrder });
              }
            }
          }
        }
        await setTabLockedValue(moved, { url: priorLock.url, lockedOrder });
      }
    }
    // Follow the tab into its new space (Arc does the same).
    await rememberActive(tab.windowId, spaceId, moved);
    await switchSpace(tab.windowId, spaceId);
    await browser.tabs.update(moved, { active: true }).catch(() => {});
  }

  /**
   * Resolve the single-level root parent (`{ itemId }` for a pinned item, or
   * `{ tabId }` for a #today tab) when a new tab is opened from `openerTabId`.
   */
  async function resolveOpenerRootParent(openerTabId, state) {
    if (openerTabId === undefined || openerTabId === null) return { parent: null, spaceId: null };
    const openerItemId = await getTabItem(openerTabId);
    if (openerItemId) {
      const found = findItem(state, openerItemId);
      if (found && !isFavKey(found.key) && !isFolder(found.item)) {
        return { parent: { itemId: openerItemId }, spaceId: found.spaceId };
      }
      if (found && isFavKey(found.key)) {
        return { parent: null, spaceId: null };
      }
    }
    const openerParent = await getTabParent(openerTabId);
    const openerSpace = await getTabSpace(openerTabId);
    if (openerParent?.itemId) {
      const found = findItem(state, openerParent.itemId);
      if (found && !isFavKey(found.key) && !isFolder(found.item)) {
        return { parent: { itemId: openerParent.itemId }, spaceId: found.spaceId };
      }
    }
    if (openerParent?.tabId) {
      const rootTab = await browser.tabs.get(openerParent.tabId).catch(() => null);
      if (rootTab) return { parent: { tabId: rootTab.id }, spaceId: openerSpace || (await getTabSpace(rootTab.id)) };
    }
    return { parent: { tabId: openerTabId }, spaceId: openerSpace };
  }

  /**
   * Place a newly created child subtab immediately after its parent's contiguous
   * family block in the browser window.
   */
  async function placeChildAfterParentBlock(tab, parent, state) {
    const winTabs = await browser.tabs.query({ windowId: tab.windowId });
    const { bound, childrenByItem, childrenByTab } = await scanTabs(winTabs, state);
    const family = [];
    if (parent.itemId) {
      const parentTab = bound.get(parent.itemId);
      if (parentTab && parentTab.windowId === tab.windowId) family.push(parentTab);
      for (const c of childrenByItem.get(parent.itemId) || []) {
        if (c.id < tab.id) family.push(c);
      }
    } else if (parent.tabId) {
      const parentTab = winTabs.find((t) => t.id === parent.tabId);
      if (parentTab) family.push(parentTab);
      for (const c of childrenByTab.get(parent.tabId) || []) {
        if (c.id < tab.id) family.push(c);
      }
    }
    if (!family.length) return;
    const maxIndex = Math.max(...family.map((t) => t.index));
    let targetIndex = maxIndex + 1;
    if (tab.index < targetIndex) targetIndex -= 1;
    if (tab.index !== targetIndex) {
      await browser.tabs.move(tab.id, { index: targetIndex }).catch(() => {});
    }
  }

  /** Give a freshly created tab a space; reopen new-tab pages in the space's container. */
  async function adoptTab(tabId) {
    if ((await getTabItem(tabId)) || (await getTabSpace(tabId))) return;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.incognito) return; // private tabs belong to no space
    const state = await getState();
    let spaceId = null;
    let parent = null;
    if (tab.openerTabId !== undefined && !isNewTabUrl(tab.url)) {
      const resolved = await resolveOpenerRootParent(tab.openerTabId, state);
      parent = resolved.parent;
      spaceId = resolved.spaceId;
    } else if (tab.openerTabId !== undefined) {
      spaceId = await getTabSpace(tab.openerTabId);
    }
    if (!state.spaces.some((s) => s.id === spaceId)) spaceId = await getWindowSpace(tab.windowId, state);
    const space = state.spaces.find((s) => s.id === spaceId);
    if (
      space.container &&
      tab.cookieStoreId !== space.container &&
      tab.openerTabId === undefined &&
      isNewTabUrl(tab.url)
    ) {
      await createTabInSpace(tab.windowId, space, { active: tab.active, index: tab.index });
      markClosing(tab.id);
      await browser.tabs.remove(tab.id);
      return;
    }
    if (parent) {
      await setTabParent(tab.id, parent);
    }
    await setTabSpace(tab.id, spaceId);
    await ensureTabRootUid(tab.id);
    if (parent) {
      await placeChildAfterParentBlock(tab, parent, state);
    }
    notify();
  }

  /**
   * When a parent #today tab closes, promote its first surviving child to root
   * and repoint any remaining sibling children to that promoted child.
   */
  async function promoteChildrenOfClosedTab(closedTabId, windowId) {
    const state = await getState();
    const query = windowId !== undefined ? { windowId } : {};
    const tabs = (await browser.tabs.query(query)).filter((t) => t.id !== closedTabId);
    await scanTabs(tabs, state);
    notify();
  }

  /** Arc has no native pinned tabs: turn one into a pinned item of its space. */
  async function convertNativePin(tab) {
    await browser.tabs.update(tab.id, { pinned: false }).catch(() => {});
    const state = await getState();
    const itemId = await getTabItem(tab.id);
    if ((itemId && findItem(state, itemId)) || !isFavoritable(tab.url)) return;
    const spaceId = (await getTabSpace(tab.id)) || (await getWindowSpace(tab.windowId, state));
    await addItem(pinKey(spaceId), tab);
  }

  /**
   * Drop blank new-tab / command-bar pages from Firefox's recently closed list,
   * so Cmd/Ctrl+Shift+T and the Archive bring back real tabs.
   */
  async function forgetBlankClosedTabs() {
    const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
    for (const entry of closed) {
      if (!entry.tab || !isNewTabUrl(entry.tab.url)) continue;
      await browser.sessions.forgetClosedTab(entry.tab.windowId, entry.tab.sessionId).catch(() => {});
    }
  }

  /* ---------- Import (from Arc) ---------- */

  // Site icon until the tab has been opened once (then the real favicon is cached).
  const guessIcon = (url) => {
    try {
      return new URL("/favicon.ico", url).href;
    } catch {
      return "";
    }
  };

  /**
   * Add imported spaces, their pinned items/folders, and favorites in one write.
   * spaces: [{name, icon, color, container, ownContainer,
   *           pins: [{type: "tab", url, title} | {type: "folder", name, children: [tab]}]}]
   * favorites: [{url, title, container}] (container null = no container)
   * replace: drop the current spaces, pins and favorites first (re-importing).
   * If the current setup is still the untouched default (one empty space, no
   * favorites), the imported spaces replace it.
   */
  async function importSpaces({ spaces, favorites = [], replace = false }) {
    let state = await getState();
    if (replace && spaces.length) {
      const old = [...state.favLists.keys(), ...state.spaces.map((sp) => pinKey(sp.id))];
      await writeLists(Object.fromEntries(old.map((k) => [k, []])));
      stateCache = null;
      await DATA.remove(old);
      state = await getState();
    }
    const pristine =
      (replace && spaces.length) ||
      (state.spaces.length === 1 && !state.favorites.length && !(state.pins.get(state.spaces[0].id) || []).length);
    const item = (t, parent) => ({ id: uid(), url: t.url, title: t.title, icon: guessIcon(t.url), ...(parent ? { parent } : {}) });
    const newSpaces = [];
    const writes = {};
    let count = 0;
    for (const sp of spaces) {
      const id = uid();
      newSpaces.push({ id, name: sp.name, icon: sp.icon || "", color: sp.color, container: sp.container || null, ownContainer: !!sp.ownContainer });
      const list = [];
      for (const x of sp.pins) {
        if (x.type === "tab") list.push(item(x));
        else {
          const folder = { id: uid(), type: "folder", name: x.name, open: false };
          list.push(folder, ...x.children.map((c) => item(c, folder.id)));
        }
      }
      count += list.filter((i) => !isFolder(i)).length;
      writes[pinKey(id)] = list;
    }
    let addedFavs = 0;
    for (const f of favorites) {
      const key = favKey({ container: f.container });
      writes[key] ??= [...listFor(state, key)];
      if (writes[key].some((x) => x.url === f.url)) continue;
      writes[key].push(item(f));
      addedFavs++;
    }
    await writeLists(writes);
    stateCache = null;
    await DATA.set({ [SPACES_KEY]: pristine && newSpaces.length ? newSpaces : [...state.spaces, ...newSpaces] });
    if (pristine && newSpaces.length) {
      stateCache = null;
      await DATA.remove(state.spaces.map((sp) => pinKey(sp.id)));
      // Open tabs from the replaced spaces move to the first imported one;
      // their pinned/favorite bindings are gone with the old lists.
      const oldIds = new Set(state.spaces.map((sp) => sp.id));
      for (const tab of await browser.tabs.query({})) {
        if (oldIds.has(await getTabSpace(tab.id))) await setTabSpace(tab.id, newSpaces[0].id);
      }
      for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) await switchSpace(win.id, newSpaces[0].id);
    }
    notify();
    return { spaces: newSpaces.length, pins: count, favorites: addedFavs, replacedDefault: pristine };
  }

  /* ---------- Favorites & pinned items ---------- */

  async function openItem(itemId, windowId) {
    const state = await getState();
    const found = findItem(state, itemId);
    if (!found || isFolder(found.item)) return null;
    const tab = await findBoundTab(state, itemId);
    if (tab) {
      await browser.tabs.update(tab.id, { active: true });
      if (tab.windowId !== windowId) await browser.windows.update(tab.windowId, { focused: true });
      return tab;
    }
    const space = found.spaceId && state.spaces.find((s) => s.id === found.spaceId);
    const container = !space && found.key.startsWith(`${FAV_KEY}@`) ? found.key.slice(FAV_KEY.length + 1) : null;
    const created = space
      ? await createTabInSpace(windowId, space, { url: found.item.url })
      : await browser.tabs
          .create({ url: found.item.url, windowId, active: true, ...(container ? { cookieStoreId: container } : {}) })
          .catch(() => browser.tabs.create({ url: found.item.url, windowId, active: true })); // container gone
    await setTabItem(created.id, itemId);
    notify();
    return created;
  }

  /** Turn a tab into a favorite (key = FAV_KEY) or pinned item (key = pinKey(space)). */
  async function addItem(key, tab, beforeId = null, { parent = null, locked = false } = {}) {
    if (!tab || !isFavoritable(tab.url)) return null;
    const state = await getState();
    const existing = await getTabItem(tab.id);
    if (existing && findItem(state, existing)) {
      await moveItem(existing, key, beforeId, { parent });
      return findItem(state, existing).item;
    }
    const priorLock = await getTabLocked(tab.id);
    const item = {
      id: uid(),
      url: !isFavKey(key) && priorLock ? priorLock.url : tab.url,
      title: tab.title || tab.url,
      icon: syncableIcon(tab.favIconUrl),
    };
    if (parent && !isFavKey(key)) item.parent = parent;
    const list = listFor(state, key).slice();
    insertInto(list, item, beforeId, item.parent);
    if (!isFavKey(key) && (locked || priorLock)) {
      const containerItems = list.filter((i) => !isFolder(i) && (i.parent || null) === (item.parent || null));
      assignLockedOrder(containerItems, containerItems.indexOf(item), true);
    }
    await writeList(key, list);
    await clearTabParent(tab.id);
    await clearTabLockedValue(tab.id);
    await setTabItem(tab.id, item.id);
    const spaceId = spaceOfKey(key);
    if (spaceId) await setTabSpace(tab.id, spaceId);
    await cacheIcon(item.id, tab.favIconUrl);
    notify();
    return item;
  }

  /**
   * Reorder an item, move it between favorites and a space's pinned list, or
   * in/out of a folder (`parent`: folder id, or null for top level).
   * Folders only live in pinned lists and don't nest.
   * Moving a locked item within the same container preserves its `lockedOrder`
   * so Clean Up can restore its default position; moving to a different
   * container assigns a new `lockedOrder` in the destination.
   */
  async function moveItem(itemId, toKey, beforeId = null, { parent = null } = {}) {
    const state = await getState();
    const found = findItem(state, itemId);
    if (!found || itemId === beforeId) return;
    if (isFolder(found.item) && (isFavKey(toKey) || parent)) return;
    const oldParent = found.item.parent || null;
    const newParent = parent && !isFavKey(toKey) ? parent : null;
    const containerChanged = found.key !== toKey || oldParent !== newParent;
    const item = { ...found.item };
    if (newParent) item.parent = newParent;
    else delete item.parent;
    if (isFavKey(toKey)) {
      delete item.locked;
      delete item.lockedOrder;
    }
    const from = found.list.filter((i) => i.id !== itemId);
    // A folder carries its items along when it moves to another space.
    const children = isFolder(item) && found.key !== toKey ? from.filter((i) => i.parent === itemId) : [];
    const fromRest = children.length ? from.filter((i) => i.parent !== itemId) : from;
    if (found.key === toKey) {
      insertInto(from, item, beforeId, item.parent);
      if (item.locked && containerChanged) {
        const containerItems = from.filter((i) => !isFolder(i) && (i.parent || null) === newParent);
        assignLockedOrder(containerItems, containerItems.indexOf(item), true);
      }
      await writeList(toKey, from);
    } else {
      const to = listFor(state, toKey).slice();
      insertInto(to, item, beforeId, item.parent);
      to.splice(to.indexOf(item) + 1, 0, ...children);
      if (item.locked && !isFavKey(toKey)) {
        const containerItems = to.filter((i) => !isFolder(i) && (i.parent || null) === newParent);
        assignLockedOrder(containerItems, containerItems.indexOf(item), true);
      }
      await writeLists({ [found.key]: fromRest, [toKey]: to });
      const spaceId = spaceOfKey(toKey);
      const allTabs = await browser.tabs.query({});
      const scanned = await scanTabs(allTabs, state);
      const movedIds = [itemId, ...children.map((c) => c.id)];
      for (const id of movedIds) {
        const boundTab = scanned.bound.get(id);
        if (spaceId && boundTab) await setTabSpace(boundTab.id, spaceId);
        for (const childTab of scanned.childrenByItem.get(id) || []) {
          if (spaceId) await setTabSpace(childTab.id, spaceId);
          else await clearTabParent(childTab.id);
        }
      }
    }
    notify();
  }

  /** Detach a pinned/favorite item's open tab and repoint its child subtabs. */
  async function detachPinnedItemTabs(itemId, { bound, childrenByItem }, state, preferredSpaceId) {
    const tab = bound.get(itemId) || null;
    const itemChildren = childrenByItem.get(itemId) || [];
    const byWin = new Map();
    for (const sub of itemChildren) {
      const list = byWin.get(sub.windowId) || [];
      list.push(sub);
      byWin.set(sub.windowId, list);
    }
    if (tab) {
      await clearTabItem(tab.id);
      const spaceId =
        preferredSpaceId || (await getTabSpace(tab.id)) || (await getWindowSpace(tab.windowId, state));
      await setTabSpace(tab.id, spaceId);
      const sameWin = byWin.get(tab.windowId) || [];
      byWin.delete(tab.windowId);
      for (const sub of sameWin) {
        await setTabSpace(sub.id, spaceId);
        await setTabParent(sub.id, { tabId: tab.id });
      }
    }
    for (const [winId, winSubs] of byWin) {
      const [first, ...rest] = winSubs;
      const winSpaceId =
        preferredSpaceId || (await getTabSpace(first.id)) || (await getWindowSpace(winId, state));
      await clearTabParent(first.id);
      await setTabSpace(first.id, winSpaceId);
      for (const sib of rest) {
        await setTabSpace(sib.id, winSpaceId);
        await setTabParent(sib.id, { tabId: first.id });
      }
    }
    await dropIcon(itemId);
    return tab;
  }

  /** Remove an item. Its tab (if open) stays open as a regular tab. */
  async function removeItem(itemId, spaceIdForTab = null) {
    const state = await getState();
    const found = findItem(state, itemId);
    if (!found) return null;
    const tabs = await browser.tabs.query({});
    const scanned = await scanTabs(tabs, state);
    const tab = await detachPinnedItemTabs(itemId, scanned, state, spaceIdForTab || found.spaceId);
    await writeList(found.key, found.list.filter((i) => i.id !== itemId));
    notify();
    return tab;
  }

  /** Navigate the item's tab back to its saved URL. */
  async function resetItem(itemId) {
    const state = await getState();
    const found = findItem(state, itemId);
    const tab = found && (await findBoundTab(state, itemId));
    if (tab) await browser.tabs.update(tab.id, { url: found.item.url });
  }

  /** Save the item tab's current page as the item's URL. */
  async function saveCurrentUrl(itemId) {
    const state = await getState();
    const found = findItem(state, itemId);
    const tab = found && (await findBoundTab(state, itemId));
    if (!tab || !isFavoritable(tab.url)) return;
    const updated = {
      ...found.item,
      url: tab.url,
      title: tab.title || tab.url,
      icon: syncableIcon(tab.favIconUrl) || found.item.icon,
    };
    await writeList(found.key, found.list.map((i) => (i.id === itemId ? updated : i)));
    await cacheIcon(itemId, tab.favIconUrl);
    notify();
  }

  /**
   * Lock or unlock a pinned item. When locking an item whose live tab has
   * navigated away from its saved URL, captures the live URL as the new
   * saved URL and assigns a `lockedOrder` within its container.
   */
  async function setItemLocked(itemId, locked) {
    const state = await getState();
    const found = findItem(state, itemId);
    if (!found || isFolder(found.item) || isFavKey(found.key)) return null;
    const list = found.list.map((i) => ({ ...i }));
    const item = list.find((i) => i.id === itemId);
    if (!item) return null;
    if (!locked) {
      delete item.locked;
      delete item.lockedOrder;
      await writeList(found.key, list);
      notify();
      return item;
    }
    const tab = await findBoundTab(state, itemId);
    if (tab && isTabAway(tab, item.url) && isFavoritable(tab.url)) {
      item.url = tab.url;
      item.title = tab.title || tab.url;
      item.icon = syncableIcon(tab.favIconUrl) || item.icon;
      await cacheIcon(itemId, tab.favIconUrl);
    }
    const containerItems = list.filter((i) => !isFolder(i) && (i.parent || null) === (item.parent || null));
    assignLockedOrder(containerItems, containerItems.indexOf(item), false);
    await writeList(found.key, list);
    notify();
    return item;
  }

  /**
   * Edit a pinned item's saved URL without navigating or interrupting its live
   * tab. Returns the normalized URL on success, or null if invalid.
   */
  async function editItemUrl(itemId, rawUrl) {
    const normalized = normalizeSavedUrl(rawUrl);
    if (!normalized) return null;
    const state = await getState();
    const found = findItem(state, itemId);
    if (!found || isFolder(found.item)) return null;
    const updated = { ...found.item, url: normalized };
    await writeList(found.key, found.list.map((i) => (i.id === itemId ? updated : i)));
    notify();
    return normalized;
  }

  /**
   * Lock or unlock an open tab.
   * - If bound to a pinned item, locks/unlocks that item.
   * - If a child subtab under a pinned item, promotes it to a locked pinned
   *   item right after its parent.
   * - If a #today tab (or child subtab in #today), promotes it to root at the
   *   end of its sibling block and records `{ url, lockedOrder }` on the tab.
   */
  async function setTabLocked(tabId, locked) {
    const state = await getState();
    const itemId = await getTabItem(tabId);
    if (itemId && findItem(state, itemId)) {
      return setItemLocked(itemId, locked);
    }
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (!locked) {
      await clearTabLockedValue(tabId);
      notify();
      return null;
    }
    if (!isFavoritable(tab.url)) return null;
    const parent = await getTabParent(tabId);
    if (parent?.itemId) {
      const foundParent = findItem(state, parent.itemId);
      if (foundParent && !isFavKey(foundParent.key)) {
        const pIdx = foundParent.list.findIndex((i) => i.id === parent.itemId);
        const beforeId = pIdx >= 0 ? foundParent.list[pIdx + 1]?.id || null : null;
        return addItem(foundParent.key, tab, beforeId, {
          parent: foundParent.item.parent || null,
          locked: true,
        });
      }
    }

    const winTabs = await browser.tabs.query({ windowId: tab.windowId });
    const scanned = await scanTabs(winTabs, state);
    const spaceId = scanned.tabSpace.get(tabId) || (await getWindowSpace(tab.windowId, state));
    if (parent?.tabId) {
      const sibs = scanned.childrenByTab.get(parent.tabId) || [];
      const lastSib = sibs[sibs.length - 1];
      if (lastSib && lastSib.id !== tabId && lastSib.index > tab.index) {
        await browser.tabs.move(tabId, { index: lastSib.index }).catch(() => {});
      }
      await clearTabParent(tabId);
    }

    const freshTabs = await browser.tabs.query({ windowId: tab.windowId });
    const freshScan = await scanTabs(freshTabs, state);
    const surviving = freshTabs
      .filter(
        (t) =>
          !freshScan.tabItem.has(t.id) &&
          !freshScan.tabParent.has(t.id) &&
          (freshScan.tabSpace.get(t.id) || spaceId) === spaceId &&
          (freshScan.tabLocked.has(t.id) || t.id === tabId)
      )
      .map((t) => {
        const ex = freshScan.tabLocked.get(t.id);
        return {
          tabId: t.id,
          url: t.id === tabId ? tab.url : ex.url,
          locked: t.id !== tabId,
          lockedOrder: ex?.lockedOrder,
        };
      });
    const targetIdx = surviving.findIndex((x) => x.tabId === tabId);
    assignLockedOrder(surviving, targetIdx >= 0 ? targetIdx : surviving.length - 1, true);
    for (const entry of surviving) {
      await setTabLockedValue(entry.tabId, { url: entry.url, lockedOrder: entry.lockedOrder });
    }
    notify();
    return surviving.find((x) => x.tabId === tabId) || null;
  }

  /** Navigate a locked #today tab (or pinned tab) back to its saved URL. */
  async function resetLockedTab(tabId) {
    const itemId = await getTabItem(tabId);
    if (itemId) return resetItem(itemId);
    const lock = await getTabLocked(tabId);
    if (lock?.url) {
      await browser.tabs.update(tabId, { url: lock.url });
      notify();
    }
  }

  /** Replace a locked #today tab's saved URL with its current live URL. */
  async function replaceLockedTabUrl(tabId) {
    const itemId = await getTabItem(tabId);
    if (itemId) return saveCurrentUrl(itemId);
    const tab = await browser.tabs.get(tabId).catch(() => null);
    const lock = await getTabLocked(tabId);
    if (!tab || !lock || !isFavoritable(tab.url)) return null;
    const updated = { ...lock, url: tab.url };
    await setTabLockedValue(tabId, updated);
    notify();
    return updated;
  }

  /** Edit a locked #today tab's saved URL without navigating the live tab. */
  async function editLockedTabUrl(tabId, rawUrl) {
    const itemId = await getTabItem(tabId);
    if (itemId) return editItemUrl(itemId, rawUrl);
    const normalized = normalizeSavedUrl(rawUrl);
    if (!normalized) return null;
    const lock = await getTabLocked(tabId);
    if (!lock) return null;
    await setTabLockedValue(tabId, { ...lock, url: normalized });
    notify();
    return normalized;
  }

  /**
   * Compute what Clean Up will do in `spaceId` for the given window state:
   * - `closeTabIds`: unlocked #today tabs and all child subtabs
   * - `resetItemIds`: pinned items whose live tab navigated away
   * - `resetTabIds`: locked #today tabs that navigated away
   * - `reorderItemIds`: locked pinned items out of their `lockedOrder`
   * - `reorderTabIds`: locked #today tabs out of their `lockedOrder`
   */
  function getCleanupPlan({ spaceId, pins = [], tabs = [], bound, tabItem, tabSpace, tabParent, tabLocked }) {
    const spaceOf = (t) => tabSpace.get(t.id) || spaceId;
    const closeTabIds = [];
    const resetItemIds = [];
    const resetTabIds = [];
    const reorderItemIds = [];
    const reorderTabIds = [];

    const windowTabIds = new Set(tabs.map((t) => t.id));
    for (const item of pins) {
      if (isFolder(item)) continue;
      const tab = bound.get(item.id);
      if (tab && windowTabIds.has(tab.id) && isTabAway(tab, item.url)) resetItemIds.push(item.id);
    }

    const reorderedPins = reorderPinListByLockedOrder(pins);
    const checkContainer = (parentId) => {
      const cur = pins.filter((i) => !isFolder(i) && (i.parent || null) === parentId);
      const next = reorderedPins.filter((i) => !isFolder(i) && (i.parent || null) === parentId);
      for (let idx = 0; idx < cur.length; idx++) {
        if (cur[idx].id !== next[idx]?.id && cur[idx].locked) {
          reorderItemIds.push(cur[idx].id);
        }
      }
    };
    checkContainer(null);
    for (const item of pins) {
      if (isFolder(item)) checkContainer(item.id);
    }

    const survivingToday = [];
    for (const t of tabs) {
      if (t.pinned) continue;
      if (tabItem.has(t.id)) continue;
      if (spaceOf(t) !== spaceId) continue;
      if (tabParent?.has(t.id)) {
        closeTabIds.push(t.id);
        continue;
      }
      const lock = tabLocked?.get(t.id);
      if (!lock) {
        closeTabIds.push(t.id);
        continue;
      }
      if (isTabAway(t, lock.url)) resetTabIds.push(t.id);
      survivingToday.push({ tab: t, locked: true, lockedOrder: lock.lockedOrder });
    }

    const reorderedToday = reorderByLockedOrder(survivingToday);
    for (let idx = 0; idx < survivingToday.length; idx++) {
      if (survivingToday[idx].tab.id !== reorderedToday[idx]?.tab.id) {
        reorderTabIds.push(survivingToday[idx].tab.id);
      }
    }

    const canCleanUp =
      closeTabIds.length > 0 ||
      resetItemIds.length > 0 ||
      resetTabIds.length > 0 ||
      reorderItemIds.length > 0 ||
      reorderTabIds.length > 0;

    return {
      canCleanUp,
      closeTabIds,
      resetItemIds,
      resetTabIds,
      reorderItemIds,
      reorderTabIds,
      reorderedPins,
      reorderedTodayTabIds: reorderedToday.map((x) => x.tab.id),
    };
  }

  /**
   * Capture the current order of locked pinned items and locked #today tabs in
   * `spaceId` as their new default `lockedOrder`.
   */
  async function saveDefaultOrder(spaceId, windowId) {
    const state = await getState();
    const key = pinKey(spaceId);
    const pins = listFor(state, key).map((i) => ({ ...i }));
    let pinsChanged = false;
    const normalizeContainer = (parentId) => {
      const items = pins.filter((i) => !isFolder(i) && (i.parent || null) === parentId);
      items.forEach((item, idx) => {
        if (item.locked && item.lockedOrder !== idx) {
          item.lockedOrder = idx;
          pinsChanged = true;
        }
      });
    };
    normalizeContainer(null);
    for (const item of pins) {
      if (isFolder(item)) normalizeContainer(item.id);
    }
    if (pinsChanged) await writeList(key, pins);

    if (windowId !== undefined && windowId !== null) {
      const tabs = await browser.tabs.query({ windowId });
      const scanned = await scanTabs(tabs, state);
      const lockedToday = tabs.filter(
        (t) =>
          !scanned.tabItem.has(t.id) &&
          !scanned.tabParent.has(t.id) &&
          (scanned.tabSpace.get(t.id) || spaceId) === spaceId &&
          scanned.tabLocked.has(t.id)
      );
      for (const [idx, t] of lockedToday.entries()) {
        const lock = scanned.tabLocked.get(t.id);
        if (lock.lockedOrder !== idx) {
          await setTabLockedValue(t.id, { ...lock, lockedOrder: idx });
        }
      }
    }
    notify();
  }

  /**
   * Execute Clean Up for `spaceId` in `windowId`:
   * 1. Reset drifted pinned items and locked #today tabs to their saved URLs.
   * 2. Restore locked pinned items and locked #today tabs to their default `lockedOrder`.
   * 3. Close unlocked #today tabs and all child subtabs (keeping the window alive).
   */
  async function cleanUpSpace(spaceId, windowId) {
    const state = await getState();
    const key = pinKey(spaceId);
    const pins = listFor(state, key);
    const tabs = await browser.tabs.query({ windowId });
    const scanned = await scanTabs(tabs, state);
    const plan = getCleanupPlan({ spaceId, pins, tabs, ...scanned });
    if (!plan.canCleanUp) return plan;

    // 1. Reset drifted pinned items and locked #today tabs.
    for (const itemId of plan.resetItemIds) {
      const found = findItem(state, itemId);
      const tab = scanned.bound.get(itemId);
      if (found && tab) await browser.tabs.update(tab.id, { url: found.item.url }).catch(() => {});
    }
    for (const tabId of plan.resetTabIds) {
      const lock = scanned.tabLocked.get(tabId);
      if (lock?.url) await browser.tabs.update(tabId, { url: lock.url }).catch(() => {});
    }

    // 2. Restore locked pinned items to their default order.
    if (plan.reorderItemIds.length > 0) {
      await writeList(key, plan.reorderedPins);
    }

    // 3. Close unlocked #today tabs and child subtabs, keeping the window alive.
    if (plan.closeTabIds.length > 0) {
      const closingSet = new Set(plan.closeTabIds);
      const remainingInWindow = tabs.filter((t) => !closingSet.has(t.id));
      const remainingInSpace = remainingInWindow.filter(
        (t) => (scanned.tabSpace.get(t.id) || spaceId) === spaceId
      );
      const activeClosing = tabs.some((t) => t.active && closingSet.has(t.id));
      if (!remainingInSpace.length) {
        const space = state.spaces.find((s) => s.id === spaceId) || state.spaces[0];
        await createTabInSpace(windowId, space);
      } else if (activeClosing) {
        const fallback =
          remainingInSpace.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] ||
          remainingInSpace[0];
        if (fallback) await browser.tabs.update(fallback.id, { active: true }).catch(() => {});
      }
      await markClosing(plan.closeTabIds);
      await browser.tabs.remove(plan.closeTabIds).catch(() => {});
    }

    // 4. Restore locked #today tabs to their default order in the browser tab strip.
    if (plan.reorderTabIds.length > 0 && plan.reorderedTodayTabIds.length > 1) {
      const afterTabs = (await browser.tabs.query({ windowId }))
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const targetSet = new Set(plan.reorderedTodayTabIds);
      let nextLocked = 0;
      const desiredIds = afterTabs.map((t) =>
        targetSet.has(t.id) ? plan.reorderedTodayTabIds[nextLocked++] : t.id
      );
      const currentIds = afterTabs.map((t) => t.id);
      for (let idx = 0; idx < desiredIds.length; idx++) {
        const wantId = desiredIds[idx];
        if (currentIds[idx] === wantId) continue;
        await browser.tabs.move(wantId, { index: idx }).catch(() => {});
        const fromIdx = currentIds.indexOf(wantId);
        if (fromIdx >= 0) {
          currentIds.splice(fromIdx, 1);
          currentIds.splice(idx, 0, wantId);
        }
      }
    }

    notify();
    return plan;
  }

  /* ---------- Folders (pinned section) ---------- */

  /**
   * New folder in a space's pinned list holding existing pinned items
   * (`itemIds`) and/or open tabs (`tabIds`, pinned on the way in). It takes the
   * place of the first selected pinned item, or goes to the end.
   */
  async function createFolder(spaceId, { name = "New Folder", itemIds = [], tabIds = [] } = {}) {
    const state = await getState();
    const key = pinKey(spaceId);
    const list = listFor(state, key).slice();
    const folder = { id: uid(), type: "folder", name, open: true };
    const picked = new Set(itemIds);
    const moved = list.filter((i) => picked.has(i.id) && !isFolder(i));
    const firstAt = list.findIndex((i) => moved.includes(i));
    const rest = list.filter((i) => !moved.includes(i));
    const inside = moved.map((i) => ({ ...i, parent: folder.id }));

    // Tabs: reuse their existing item if they already have one, else pin them.
    for (const tabId of tabIds) {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab || !isFavoritable(tab.url)) continue;
      const bound = await getTabItem(tab.id);
      if (bound && findItem(state, bound)) continue;
      const priorLock = await getTabLocked(tab.id);
      const item = {
        id: uid(),
        url: priorLock?.url || tab.url,
        title: tab.title || tab.url,
        icon: syncableIcon(tab.favIconUrl),
        parent: folder.id,
        ...(priorLock ? { locked: true, lockedOrder: inside.length } : {}),
      };
      inside.push(item);
      await clearTabParent(tab.id);
      await clearTabLockedValue(tab.id);
      await setTabItem(tab.id, item.id);
      await setTabSpace(tab.id, spaceId);
      await cacheIcon(item.id, tab.favIconUrl);
    }
    inside.forEach((it, idx) => {
      if (it.locked) it.lockedOrder = idx;
    });
    const at = firstAt >= 0 ? rest.indexOf(list.slice(firstAt).find((i) => rest.includes(i))) : -1;
    if (at >= 0) rest.splice(at, 0, folder, ...inside);
    else rest.push(folder, ...inside);
    await writeList(key, rest);
    notify();
    return folder;
  }

  async function updateFolder(folderId, patch) {
    const state = await getState();
    const found = findItem(state, folderId);
    if (!found || !isFolder(found.item)) return;
    const list = found.list.map((i) => (i.id === folderId ? { ...i, ...patch } : i));
    await writeList(found.key, list);
    notify();
  }

  /** Remove a folder; its items move to the top level (keepItems) or are removed too. */
  async function deleteFolder(folderId, { keepItems = true } = {}) {
    const state = await getState();
    const found = findItem(state, folderId);
    if (!found || !isFolder(found.item)) return;
    const children = found.list.filter((i) => i.parent === folderId);
    if (!keepItems) {
      const tabs = await browser.tabs.query({});
      const scanned = await scanTabs(tabs, state);
      for (const child of children) {
        await detachPinnedItemTabs(child.id, scanned, state, found.spaceId);
      }
    }
    const movedIds = new Set(keepItems ? children.map((c) => c.id) : []);
    const list = found.list
      .filter((i) => i.id !== folderId && (keepItems || i.parent !== folderId))
      .map((i) => {
        if (i.parent !== folderId) return i;
        const { parent, ...rest } = i;
        return rest;
      });
    if (keepItems && children.some((c) => c.locked)) {
      const topLevel = list.filter((i) => !isFolder(i) && !i.parent);
      for (let idx = 0; idx < topLevel.length; idx++) {
        if (movedIds.has(topLevel[idx].id) && topLevel[idx].locked) {
          assignLockedOrder(topLevel, idx, true);
        }
      }
    }
    await writeList(found.key, list);
    notify();
  }

  /* ---------- Tab badges from other extensions ---------- */

  /* ---------- Which container a page was seen in ----------
   * Firefox's history has no container: a visit is a visit, whichever cookie
   * jar it happened in (HistoryItem is {id, url, title, lastVisitTime,
   * visitCount, typedCount}). Arc keeps its own note of where it saw a page so
   * the command bar and address bar can suggest this space's pages. Pages Arc
   * never saw — everything visited before this, or in another browser session —
   * have no container and stay visible everywhere. */

  async function getVisits() {
    if (visitCache) return visitCache;
    const { [VISITS_KEY]: visits = {} } = await browser.storage.local.get(VISITS_KEY);
    visitCache = visits;
    return visits;
  }

  /** Note that `url` was seen in `cookieStoreId`. */
  async function recordVisit(url, cookieStoreId) {
    if (!/^https?:\/\//i.test(url || "") || !cookieStoreId) return;
    const visits = await getVisits();
    const entry = visits[url] || { s: [], t: 0 };
    if (!entry.s.includes(cookieStoreId)) entry.s = [...entry.s, cookieStoreId].slice(-4);
    entry.t = Date.now();
    visits[url] = entry;
    const urls = Object.keys(visits);
    if (urls.length > MAX_VISITS) {
      // Drop the oldest; this is a hint for suggestions, not a history of record.
      urls
        .sort((a, b) => (visits[a].t || 0) - (visits[b].t || 0))
        .slice(0, urls.length - MAX_VISITS)
        .forEach((u) => delete visits[u]);
    }
    visitCache = visits;
    await browser.storage.local.set({ [VISITS_KEY]: visits });
  }

  /** True when `url` belongs in `cookieStoreId`'s suggestions. */
  async function seenInContainer(url, cookieStoreId) {
    if (!cookieStoreId) return true;
    const visits = await getVisits();
    const entry = visits[url];
    return !entry || entry.s.includes(cookieStoreId);
  }

  const MAX_BADGES = 200; // per extension
  const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const BADGE_ICONS = ["bot", "sparkles"]; // drawn by the sidebar (Lucide); no outside SVG
  const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  // One write at a time: each one reads and rewrites the whole badge map.
  let badgeWrites = Promise.resolve();

  /** Replace the badges `extensionId` shows on tabs. Only plain text, hex colors and known icon names get through. */
  function setBadges(extensionId, badges) {
    const write = badgeWrites.then(() => writeBadges(extensionId, badges));
    badgeWrites = write.catch(() => {});
    return write;
  }

  async function writeBadges(extensionId, badges) {
    const clean = (Array.isArray(badges) ? badges : [])
      .slice(0, MAX_BADGES)
      .filter((b) => Number.isInteger(b?.tabId) && (text(b.label, 12) || BADGE_ICONS.includes(b.icon)))
      .map((b) => ({
        tabId: b.tabId,
        label: text(b.label, 12),
        title: text(b.title, 120),
        color: HEX_COLOR.test(b.color || "") ? b.color : "",
        icon: BADGE_ICONS.includes(b.icon) ? b.icon : "",
        position: b.position === "start" ? "start" : "end",
        pulse: b.pulse === true,
      }));
    const { [BADGES_KEY]: all = {} } = await browser.storage.session.get(BADGES_KEY);
    if (clean.length) all[extensionId] = clean;
    else delete all[extensionId];
    await browser.storage.session.set({ [BADGES_KEY]: all });
    await rememberProvider(extensionId);
  }

  /** Badges by tab id, from every extension. */
  async function getBadges() {
    const { [BADGES_KEY]: all = {} } = await browser.storage.session.get(BADGES_KEY).catch(() => ({}));
    const byTab = new Map();
    for (const badges of Object.values(all)) {
      for (const b of badges) byTab.set(b.tabId, [...(byTab.get(b.tabId) || []), b]);
    }
    return byTab;
  }

  /* ---------- Tab menu items from other extensions ---------- */

  const MAX_MENU_ITEMS = 5; // per extension
  const tabIdList = (v) => (Array.isArray(v) ? v.filter(Number.isInteger).slice(0, 1000) : null);

  /** Replace the tab menu items `extensionId` adds. Titles are plain text. */
  function setTabMenu(extensionId, items) {
    const write = badgeWrites.then(() => writeTabMenu(extensionId, items));
    badgeWrites = write.catch(() => {});
    return write;
  }

  async function writeTabMenu(extensionId, items) {
    const clean = (Array.isArray(items) ? items : [])
      .slice(0, MAX_MENU_ITEMS)
      .filter((m) => /^[\w-]{1,64}$/.test(m?.id || "") && text(m.title, 60))
      .map((m) => ({ id: m.id, title: text(m.title, 60), tabIds: tabIdList(m.tabIds), exceptTabIds: tabIdList(m.exceptTabIds) }));
    const { [TAB_MENU_KEY]: all = {} } = await browser.storage.session.get(TAB_MENU_KEY);
    if (clean.length) all[extensionId] = clean;
    else delete all[extensionId];
    await browser.storage.session.set({ [TAB_MENU_KEY]: all });
    await rememberProvider(extensionId);
  }

  /** Menu items other extensions want on `tabId`, as [{ extensionId, id, title }]. */
  async function tabMenuFor(tabId) {
    const { [TAB_MENU_KEY]: all = {} } = await browser.storage.session.get(TAB_MENU_KEY).catch(() => ({}));
    const out = [];
    for (const [extensionId, items] of Object.entries(all)) {
      for (const m of items) {
        if (m.tabIds && !m.tabIds.includes(tabId)) continue;
        if (m.exceptTabIds?.includes(tabId)) continue;
        out.push({ extensionId, id: m.id, title: m.title });
      }
    }
    return out;
  }

  async function rememberProvider(extensionId) {
    const { [BADGE_PROVIDERS_KEY]: providers = [] } = await browser.storage.local.get(BADGE_PROVIDERS_KEY);
    if (!providers.includes(extensionId)) {
      await browser.storage.local.set({ [BADGE_PROVIDERS_KEY]: [...providers, extensionId] });
    }
  }

  /**
   * Drop the badges and menu items of extensions that are gone (disabled or removed): they can't
   * clear their own. A message to a missing extension fails; one that's there just ignores it.
   * `force` skips the 10 s throttle.
   */
  let lastProviderCheck = 0;
  async function pruneProviders(force = false) {
    if (!force && Date.now() - lastProviderCheck < 10000) return;
    lastProviderCheck = Date.now();
    const [{ [BADGES_KEY]: badges = {} }, { [TAB_MENU_KEY]: menus = {} }] = await Promise.all([
      browser.storage.session.get(BADGES_KEY).catch(() => ({})),
      browser.storage.session.get(TAB_MENU_KEY).catch(() => ({})),
    ]);
    const ids = new Set([...Object.keys(badges), ...Object.keys(menus)]);
    await Promise.all([...ids].map((id) =>
      browser.runtime.sendMessage(id, { type: "arcsidebar:ping" }).catch(() => Promise.all([setBadges(id, []), setTabMenu(id, [])]))));
  }

  /** Badges and menu items live in session storage: ask the extensions that set them before to send them again. */
  async function announceToBadgeProviders() {
    const { [BADGE_PROVIDERS_KEY]: providers = [] } = await browser.storage.local.get(BADGE_PROVIDERS_KEY);
    for (const id of providers) browser.runtime.sendMessage(id, { type: "arcsidebar:ready" }).catch(() => {});
  }

  return {
    markClosing,
    takeClosing,
    setBadges,
    getBadges,
    setTabMenu,
    tabMenuFor,
    pruneProviders,
    announceToBadgeProviders,
    BADGES_KEY,
    FAV_KEY,
    favKey,
    isFavKey,
    SPACES_KEY,
    PIN_PREFIX,
    ICON_KEY,
    COLORS,
    pinKey,
    isFavoritable,
    isNewTabUrl,
    isFirefoxNewTab,
    normUrl,
    sameUrl,
    normalizeSavedUrl,
    isTabAway,
    reorderByLockedOrder,
    assignLockedOrder,
    reorderPinListByLockedOrder,
    notify,
    getState,
    findItem,
    getIconCache,
    cacheIcon,
    getTabItem,
    getTabSpace,
    setTabSpace,
    getTabParent,
    setTabParent,
    clearTabParent,
    getTabLocked,
    scanTabs,
    recordVisit,
    seenInContainer,
    getWindowSpace,
    rememberActive,
    createTabInSpace,
    topIndexOfSpace,
    switchSpace,
    syncVisibility,
    saveSpace,
    adoptArcContainers,
    moveSpace,
    spaceTabs,
    deleteSpace,
    moveTabToSpace,
    adoptTab,
    promoteChildrenOfClosedTab,
    convertNativePin,
    forgetBlankClosedTabs,
    importSpaces,
    openItem,
    addItem,
    moveItem,
    removeItem,
    resetItem,
    saveCurrentUrl,
    setItemLocked,
    editItemUrl,
    setTabLocked,
    resetLockedTab,
    replaceLockedTabUrl,
    editLockedTabUrl,
    getCleanupPlan,
    saveDefaultOrder,
    cleanUpSpace,
    isFolder,
    createFolder,
    updateFolder,
    deleteFolder,
  };
})();
