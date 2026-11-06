import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const storeCode = fs.readFileSync(new URL("../shared/store.js", import.meta.url), "utf8");

function createHarness() {
  const localStore = {};
  const sessionStore = {};
  const tabValues = new Map(); // tabId -> Map(key, val)
  let tabs = [];
  let nextTabId = 1;

  const getStore = (area) => (area === "local" ? localStore : sessionStore);
  const makeStorageArea = (area) => ({
    async get(keys) {
      const src = getStore(area);
      if (!keys) return structuredClone(src);
      if (typeof keys === "string") {
        return keys in src ? { [keys]: structuredClone(src[keys]) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in src) out[k] = structuredClone(src[k]);
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys)) {
        out[k] = k in src ? structuredClone(src[k]) : def;
      }
      return out;
    },
    async set(obj) {
      const dst = getStore(area);
      for (const [k, v] of Object.entries(obj)) dst[k] = structuredClone(v);
    },
    async remove(keys) {
      const dst = getStore(area);
      for (const k of [].concat(keys)) delete dst[k];
    },
  });

  const reindexWindow = (windowId) => {
    const winTabs = tabs.filter((t) => t.windowId === windowId);
    winTabs.forEach((t, idx) => {
      t.index = idx;
    });
  };

  const addTab = ({
    id = nextTabId++,
    windowId = 1,
    url = "https://example.com/",
    title = url,
    active = false,
    pinned = false,
    hidden = false,
    openerTabId = undefined,
    cookieStoreId = "firefox-default",
    index = undefined,
  } = {}) => {
    if (active) {
      for (const t of tabs) if (t.windowId === windowId) t.active = false;
    }
    const tab = {
      id,
      windowId,
      url,
      title,
      active,
      pinned,
      hidden,
      openerTabId,
      cookieStoreId,
      status: "complete",
      index: 0,
    };
    const winTabs = tabs.filter((t) => t.windowId === windowId);
    const insertAt = index === undefined ? winTabs.length : Math.max(0, Math.min(index, winTabs.length));
    // Splice into tabs at the right relative position for windowId
    let globalIdx = tabs.length;
    if (insertAt < winTabs.length) {
      globalIdx = tabs.indexOf(winTabs[insertAt]);
    }
    tabs.splice(globalIdx, 0, tab);
    reindexWindow(windowId);
    return tab;
  };

  const removedListeners = [];
  const browser = {
    runtime: {
      getURL: (p) => `moz-extension://test-uuid/${p}`,
      sendMessage: async () => {},
      onMessage: { addListener() {} },
    },
    storage: {
      local: makeStorageArea("local"),
      session: makeStorageArea("session"),
      sync: makeStorageArea("sync"),
      onChanged: { addListener() {} },
    },
    sessions: {
      async setTabValue(tabId, key, val) {
        if (!tabValues.has(tabId)) tabValues.set(tabId, new Map());
        tabValues.get(tabId).set(key, structuredClone(val));
      },
      async getTabValue(tabId, key) {
        return structuredClone(tabValues.get(tabId)?.get(key));
      },
      async removeTabValue(tabId, key) {
        tabValues.get(tabId)?.delete(key);
      },
    },
    tabs: {
      onRemoved: {
        addListener(fn) {
          removedListeners.push(fn);
        },
      },
      async get(tabId) {
        const t = tabs.find((x) => x.id === tabId);
        if (!t) throw new Error(`No tab ${tabId}`);
        return { ...t };
      },
      async query(q = {}) {
        return tabs
          .filter((t) => {
            if (q.windowId !== undefined && t.windowId !== q.windowId) return false;
            if (q.active !== undefined && t.active !== q.active) return false;
            if (q.hidden !== undefined && t.hidden !== q.hidden) return false;
            return true;
          })
          .map((t) => ({ ...t }));
      },
      async create(props = {}) {
        return { ...addTab(props) };
      },
      async update(tabId, patch = {}) {
        const t = tabs.find((x) => x.id === tabId);
        if (!t) throw new Error(`No tab ${tabId}`);
        if (patch.active) {
          for (const other of tabs) if (other.windowId === t.windowId) other.active = false;
        }
        Object.assign(t, patch);
        return { ...t };
      },
      async remove(ids) {
        const rm = new Set([].concat(ids));
        const affectedWindows = new Set(tabs.filter((t) => rm.has(t.id)).map((t) => t.windowId));
        tabs = tabs.filter((t) => !rm.has(t.id));
        for (const id of rm) {
          tabValues.delete(id);
          for (const fn of removedListeners) fn(id, {});
        }
        for (const w of affectedWindows) reindexWindow(w);
      },
      async move(ids, { windowId, index }) {
        const moveIds = [].concat(ids);
        const moving = moveIds.map((id) => tabs.find((t) => t.id === id)).filter(Boolean);
        if (!moving.length) return [];
        const targetWin = windowId ?? moving[0].windowId;
        tabs = tabs.filter((t) => !moveIds.includes(t.id));
        for (const t of moving) t.windowId = targetWin;
        const winTabs = tabs.filter((t) => t.windowId === targetWin);
        const clamped = index < 0 || index >= winTabs.length ? winTabs.length : index;
        const globalIdx = clamped < winTabs.length ? tabs.indexOf(winTabs[clamped]) : tabs.length;
        tabs.splice(globalIdx, 0, ...moving);
        reindexWindow(targetWin);
        return moving.map((t) => ({ ...t }));
      },
      async show(ids) {
        for (const id of [].concat(ids)) {
          const t = tabs.find((x) => x.id === id);
          if (t) t.hidden = false;
        }
      },
      async hide(ids) {
        for (const id of [].concat(ids)) {
          const t = tabs.find((x) => x.id === id);
          if (t) t.hidden = true;
        }
      },
    },
    windows: {
      async getAll() {
        const winIds = [...new Set(tabs.map((t) => t.windowId))];
        return (winIds.length ? winIds : [1]).map((id) => ({ id, incognito: false }));
      },
    },
  };

  const ArcFox = new Function("browser", `${storeCode}\nreturn ArcFox;`)(browser);

  return { ArcFox, browser, addTab, getTabs: () => tabs };
}

test("normalizeSavedUrl and isTabAway handle scheme defaults, trailing slashes, and live navigation", () => {
  const { ArcFox } = createHarness();

  assert.equal(ArcFox.normalizeSavedUrl("github.com/robert-crandall"), "https://github.com/robert-crandall");
  assert.equal(ArcFox.normalizeSavedUrl("localhost:3000/app"), "https://localhost:3000/app");
  assert.equal(ArcFox.normalizeSavedUrl("example.com:8080/path"), "https://example.com:8080/path");
  assert.equal(ArcFox.normalizeSavedUrl("https://example.com"), "https://example.com/");
  assert.equal(ArcFox.normalizeSavedUrl(""), null);
  assert.equal(ArcFox.normalizeSavedUrl("javascript:alert(1)"), null);

  assert.equal(
    ArcFox.isTabAway({ url: "https://example.com/", status: "complete" }, "https://example.com"),
    false
  );
  assert.equal(
    ArcFox.isTabAway({ url: "https://example.com/docs", status: "complete" }, "https://example.com/"),
    true
  );
  assert.equal(
    ArcFox.isTabAway({ url: "about:blank", status: "loading" }, "https://example.com/"),
    false
  );
});

test("single-level child subtabs attach under their root parent and promote on parent close", async () => {
  const { ArcFox, browser, addTab } = createHarness();
  const state = await ArcFox.getState();
  const spaceId = state.spaces[0].id;

  const rootTab = addTab({ id: 10, url: "https://news.ycombinator.com/", active: true });
  await ArcFox.setTabSpace(rootTab.id, spaceId);

  // Open two links concurrently from rootTab -> both attach to rootTab with one shared rootUid
  const child1 = addTab({
    id: 11,
    url: "https://example.com/article-1",
    openerTabId: rootTab.id,
  });
  const child2 = addTab({
    id: 12,
    url: "https://example.com/article-2",
    openerTabId: rootTab.id,
  });
  await Promise.all([ArcFox.adoptTab(child1.id), ArcFox.adoptTab(child2.id)]);

  // Open a link from child1 -> flattens to single-level sibling under rootTab, placed after parent's block
  const child3 = addTab({
    id: 13,
    url: "https://example.com/article-3",
    openerTabId: child1.id,
    index: 0, // even if Firefox initially places it elsewhere, adoptTab places it after parent's block
  });
  await ArcFox.adoptTab(child3.id);

  assert.deepEqual(await ArcFox.getTabParent(child1.id), { tabId: rootTab.id });
  assert.deepEqual(await ArcFox.getTabParent(child2.id), { tabId: rootTab.id });
  assert.deepEqual(await ArcFox.getTabParent(child3.id), { tabId: rootTab.id });

  const orderedIds = (await browser.tabs.query({ windowId: 1 })).map((t) => t.id);
  assert.deepEqual(orderedIds, [rootTab.id, child1.id, child2.id, child3.id]);

  // Closing rootTab promotes child1 to root and repoints child2 and child3 to child1 across scans
  await browser.tabs.remove(rootTab.id);
  await ArcFox.scanTabs(await browser.tabs.query({ windowId: 1 }), await ArcFox.getState());
  const secondScan = await ArcFox.scanTabs(await browser.tabs.query({ windowId: 1 }), await ArcFox.getState());

  assert.equal(await ArcFox.getTabParent(child1.id), undefined);
  assert.deepEqual(await ArcFox.getTabParent(child2.id), { tabId: child1.id });
  assert.deepEqual(await ArcFox.getTabParent(child3.id), { tabId: child1.id });
  assert.deepEqual(
    (secondScan.childrenByTab.get(child1.id) || []).map((t) => t.id),
    [child2.id, child3.id]
  );
});

test("locking, editing saved URL without navigation, replacing saved URL, and returning to locked page", async () => {
  const { ArcFox, browser, addTab } = createHarness();
  const state = await ArcFox.getState();
  const spaceId = state.spaces[0].id;
  const pinKey = ArcFox.pinKey(spaceId);

  // Add a pinned item and bind a tab
  const pinTab = addTab({ id: 20, url: "https://docs.example.com/start", title: "Docs", active: true });
  await ArcFox.setTabSpace(pinTab.id, spaceId);
  const item = await ArcFox.addItem(pinKey, pinTab);

  // Navigate the pinned tab away from its saved URL
  await browser.tabs.update(pinTab.id, { url: "https://docs.example.com/deep-page" });

  // Edit the saved URL without interrupting the open page
  const updatedUrl = await ArcFox.editItemUrl(item.id, "docs.example.com/home");
  assert.equal(updatedUrl, "https://docs.example.com/home");
  assert.equal((await browser.tabs.get(pinTab.id)).url, "https://docs.example.com/deep-page");

  // Return to the locked/saved page
  await ArcFox.resetItem(item.id);
  assert.equal((await browser.tabs.get(pinTab.id)).url, "https://docs.example.com/home");

  // Lock a Today tab, navigate away, edit its locked URL, and return to locked page
  const todayTab = addTab({ id: 21, url: "https://app.example.com/dashboard", title: "Dashboard" });
  await ArcFox.setTabSpace(todayTab.id, spaceId);
  await ArcFox.setTabLocked(todayTab.id, true);

  let lock = await ArcFox.getTabLocked(todayTab.id);
  assert.equal(lock.url, "https://app.example.com/dashboard");
  assert.equal(typeof lock.lockedOrder, "number");

  await browser.tabs.update(todayTab.id, { url: "https://app.example.com/settings" });
  await ArcFox.replaceLockedTabUrl(todayTab.id);
  lock = await ArcFox.getTabLocked(todayTab.id);
  assert.equal(lock.url, "https://app.example.com/settings");

  await browser.tabs.update(todayTab.id, { url: "https://app.example.com/profile" });
  await ArcFox.resetLockedTab(todayTab.id);
  assert.equal((await browser.tabs.get(todayTab.id)).url, "https://app.example.com/settings");
});

test("Clean Up closes unlocked tabs, resets drifted locked tabs, and restores default locked order", async () => {
  const { ArcFox, browser, addTab } = createHarness();
  const state = await ArcFox.getState();
  const spaceId = state.spaces[0].id;
  const pinKey = ArcFox.pinKey(spaceId);

  // Create two locked pinned items in default order [pinA, pinB]
  const tabPinA = addTab({ id: 30, url: "https://a.example.com/", title: "A" });
  const tabPinB = addTab({ id: 31, url: "https://b.example.com/", title: "B" });
  await ArcFox.setTabSpace(tabPinA.id, spaceId);
  await ArcFox.setTabSpace(tabPinB.id, spaceId);
  const pinA = await ArcFox.addItem(pinKey, tabPinA);
  const pinB = await ArcFox.addItem(pinKey, tabPinB);
  await ArcFox.setItemLocked(pinA.id, true);
  await ArcFox.setItemLocked(pinB.id, true);

  // Reorder pinB before pinA and navigate pinA away
  await ArcFox.moveItem(pinB.id, pinKey, pinA.id);
  await browser.tabs.update(tabPinA.id, { url: "https://a.example.com/drifted" });

  // Create two locked Today tabs in default order [locked1, locked2] and one unlocked Today tab + child subtab
  const locked1 = addTab({ id: 32, url: "https://one.example.com/", title: "One" });
  const locked2 = addTab({ id: 33, url: "https://two.example.com/", title: "Two" });
  const unlocked = addTab({ id: 34, url: "https://temp.example.com/", title: "Temp" });
  await ArcFox.setTabSpace(locked1.id, spaceId);
  await ArcFox.setTabSpace(locked2.id, spaceId);
  await ArcFox.setTabSpace(unlocked.id, spaceId);
  await ArcFox.setTabLocked(locked1.id, true);
  await ArcFox.setTabLocked(locked2.id, true);

  const subtab = addTab({
    id: 35,
    url: "https://one.example.com/child",
    openerTabId: locked1.id,
  });
  await ArcFox.adoptTab(subtab.id);

  // Reorder locked2 before locked1 and drift locked1
  await browser.tabs.move(locked2.id, { windowId: 1, index: 2 });
  await browser.tabs.update(locked1.id, { url: "https://one.example.com/away" });

  const stBefore = await ArcFox.getState();
  const allBefore = await browser.tabs.query({ windowId: 1 });
  const scanBefore = await ArcFox.scanTabs(allBefore, stBefore);
  const plan = ArcFox.getCleanupPlan({
    spaceId,
    pins: stBefore.pins.get(spaceId),
    tabs: allBefore,
    bound: scanBefore.bound,
    tabItem: scanBefore.tabItem,
    tabSpace: scanBefore.tabSpace,
    tabParent: scanBefore.tabParent,
    tabLocked: scanBefore.tabLocked,
  });

  assert.equal(plan.canCleanUp, true);
  assert.deepEqual(plan.closeTabIds.sort(), [unlocked.id, subtab.id].sort());
  assert.deepEqual(plan.resetItemIds, [pinA.id]);
  assert.deepEqual(plan.resetTabIds, [locked1.id]);
  assert.equal(plan.reorderItemIds.length > 0, true);
  assert.equal(plan.reorderTabIds.length > 0, true);

  await ArcFox.cleanUpSpace(spaceId, 1);

  const stAfter = await ArcFox.getState();
  const pinsAfter = stAfter.pins.get(spaceId);
  assert.deepEqual(
    pinsAfter.map((p) => p.id),
    [pinA.id, pinB.id]
  );
  assert.equal((await browser.tabs.get(tabPinA.id)).url, "https://a.example.com/");
  assert.equal((await browser.tabs.get(locked1.id)).url, "https://one.example.com/");

  const remainingToday = (await browser.tabs.query({ windowId: 1 })).filter(
    (t) => ![tabPinA.id, tabPinB.id].includes(t.id)
  );
  assert.deepEqual(
    remainingToday.map((t) => t.id),
    [locked1.id, locked2.id]
  );
});

test("reconciles child subtab parent across session-restore ID changes and preserves locks across folder/space moves", async () => {
  const { ArcFox, browser, addTab } = createHarness();
  const state = await ArcFox.getState();
  const spaceId = state.spaces[0].id;

  const rootTab = addTab({ id: 50, url: "https://root.example.com/", active: true });
  await ArcFox.setTabSpace(rootTab.id, spaceId);
  const childTab = addTab({ id: 51, url: "https://root.example.com/child", openerTabId: rootTab.id });
  await ArcFox.adoptTab(childTab.id);

  const rootUid = await browser.sessions.getTabValue(rootTab.id, "arcfoxRootId");
  assert.equal(typeof rootUid, "string");

  // Simulate Firefox reassigning rootTab's numeric ID on session restore (50 -> 90)
  await browser.tabs.remove(rootTab.id);
  const restoredRoot = addTab({ id: 90, url: "https://root.example.com/", index: 0 });
  await browser.sessions.setTabValue(restoredRoot.id, "arcfoxSpace", spaceId);
  await browser.sessions.setTabValue(restoredRoot.id, "arcfoxRootId", rootUid);

  const scanned = await ArcFox.scanTabs(await browser.tabs.query({ windowId: 1 }), await ArcFox.getState());
  assert.deepEqual(scanned.tabParent.get(childTab.id), { tabId: restoredRoot.id });
  assert.deepEqual(await ArcFox.getTabParent(childTab.id), { tabId: restoredRoot.id });

  // Simulate restoredRoot disappearing and an unrelated tab reusing numeric ID 90 without arcfoxRootId
  await browser.tabs.remove(restoredRoot.id);
  const unrelatedReuse = addTab({ id: 90, url: "https://unrelated.example.com/", index: 0 });
  await browser.sessions.setTabValue(unrelatedReuse.id, "arcfoxSpace", spaceId);
  const scannedAfterReuse = await ArcFox.scanTabs(await browser.tabs.query({ windowId: 1 }), await ArcFox.getState());
  assert.equal(scannedAfterReuse.tabParent.get(childTab.id), undefined);
  assert.equal(await ArcFox.getTabParent(childTab.id), undefined);

  // Pinning a locked Today tab into a folder preserves its lock and rebases on folder deletion
  const lockedToday = addTab({ id: 95, url: "https://locked.example.com/home" });
  await ArcFox.setTabSpace(lockedToday.id, spaceId);
  await ArcFox.setTabLocked(lockedToday.id, true);
  await browser.tabs.update(lockedToday.id, { url: "https://locked.example.com/drifted" });

  const folder = await ArcFox.createFolder(spaceId, { name: "Work", tabIds: [lockedToday.id] });
  const afterFolder = await ArcFox.getState();
  const folderItem = afterFolder.pins.get(spaceId).find((i) => i.parent === folder.id);
  assert.equal(folderItem.locked, true);
  assert.equal(folderItem.url, "https://locked.example.com/home");
  assert.equal(await ArcFox.getTabLocked(lockedToday.id), undefined);

  await ArcFox.deleteFolder(folder.id, { keepItems: true });
  const afterDelete = await ArcFox.getState();
  const promotedItem = afterDelete.pins.get(spaceId).find((i) => i.id === folderItem.id);
  assert.equal(promotedItem.locked, true);
  assert.equal(promotedItem.parent, undefined);
});

