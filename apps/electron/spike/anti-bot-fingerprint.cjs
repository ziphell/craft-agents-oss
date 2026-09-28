"use strict";

// apps/electron/spike/anti-bot-fingerprint.ts
var import_electron = require("electron");
var import_node_http = require("node:http");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var REPORT_PATH = process.env.SPIKE_REPORT || (0, import_node_path.join)(__dirname, "anti-bot-fingerprint.report.json");
function writeReport(payload) {
  try {
    (0, import_node_fs.writeFileSync)(REPORT_PATH, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    (0, import_node_fs.writeFileSync)(REPORT_PATH.replace(/\.json$/, ".err.txt"), String(error), "utf8");
  }
}
process.on("uncaughtException", (error) => writeReport({ uncaught: String(error && error.stack ? error.stack : error) }));
process.on("unhandledRejection", (reason) => writeReport({ unhandled: String(reason) }));
import_electron.app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
import_electron.app.setName(process.env.CRAFT_APP_NAME || "Craft Agents");
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:#123;color:#fff;font:14px sans-serif}</style>
</head><body><p id="note">probe</p>
<script>
window.__probe = async function () {
  const out = {
    ua: navigator.userAgent,
    webdriver: typeof navigator.webdriver === 'undefined' ? '(undefined)' : navigator.webdriver,
    webdriverType: typeof navigator.webdriver,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version) : null,
    uaDataPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    uaDataMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
    fullVersionList: null,
    chromeType: typeof window.chrome,
    chromeKeys: window.chrome ? Object.keys(window.chrome).sort() : null,
    chromeRuntime: typeof (window.chrome && window.chrome.runtime),
    plugins: navigator.plugins.length,
    mimeTypes: navigator.mimeTypes.length,
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    languages: (navigator.languages || []).join(','),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory === undefined ? '(undefined)' : navigator.deviceMemory,
    notificationPermission: typeof Notification === 'undefined' ? '(no Notification)' : Notification.permission,
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
    hidden: document.hidden,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    screenX: window.screenX,
    screenY: window.screenY,
    screen: window.screen.width + 'x' + window.screen.height,
    avail: window.screen.availWidth + 'x' + window.screen.availHeight,
    devicePixelRatio: window.devicePixelRatio,
    webglVendor: (function () {
      try {
        const gl = document.createElement('canvas').getContext('webgl')
        if (!gl) return '(no webgl)'
        const ext = gl.getExtension('WEBGL_debug_renderer_info')
        return ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : '(no debug ext)'
      } catch (e) { return 'err:' + e.message }
    })(),
    webglRenderer: (function () {
      try {
        const gl = document.createElement('canvas').getContext('webgl')
        if (!gl) return '(no webgl)'
        const ext = gl.getExtension('WEBGL_debug_renderer_info')
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '(no debug ext)'
      } catch (e) { return 'err:' + e.message }
    })(),
    permissionsState: null,
  }
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    try {
      const hev = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion', 'architecture', 'bitness', 'model'])
      out.fullVersionList = (hev.fullVersionList || []).map((b) => b.brand + '/' + b.version)
      out.hev = { platform: hev.platform, platformVersion: hev.platformVersion, architecture: hev.architecture, bitness: hev.bitness, model: hev.model }
    } catch (e) { out.fullVersionList = 'err:' + e.message }
  }
  try {
    const st = await navigator.permissions.query({ name: 'notifications' })
    out.permissionsState = st.state
  } catch (e) { out.permissionsState = 'err:' + e.message }
  return out
}
</script></body></html>`;
var seenHeaders = [];
function startServer() {
  return new Promise((resolve) => {
    const server = (0, import_node_http.createServer)((req, res) => {
      seenHeaders.push({
        path: req.url,
        userAgent: req.headers["user-agent"],
        secChUa: req.headers["sec-ch-ua"],
        secChUaMobile: req.headers["sec-ch-ua-mobile"],
        secChUaPlatform: req.headers["sec-ch-ua-platform"],
        secChUaFullVersionList: req.headers["sec-ch-ua-full-version-list"],
        acceptLanguage: req.headers["accept-language"],
        secFetchSite: req.headers["sec-fetch-site"],
        secFetchMode: req.headers["sec-fetch-mode"]
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
async function load(wc, url) {
  const loaded = new Promise((resolve) => wc.once("did-finish-load", resolve));
  await wc.loadURL(url);
  await loaded;
}
async function probe(wc) {
  try {
    return await wc.executeJavaScript("window.__probe()");
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
}
async function main() {
  const server = await startServer();
  const report = {};
  writeReport({ phase: "server-up" });
  const workArea = import_electron.screen.getPrimaryDisplay().workArea;
  const spot = { x: workArea.x + workArea.width + 2e4, y: workArea.y + 2e4 };
  const SIZE = { width: 900, height: 620 };
  const onscreen = new import_electron.BrowserWindow({
    x: workArea.x + 40,
    y: workArea.y + 40,
    ...SIZE,
    frame: false,
    show: true,
    backgroundColor: "#123"
  });
  const tabA = new import_electron.WebContentsView({ webPreferences: { backgroundThrottling: false } });
  tabA.setBounds({ x: 0, y: 0, ...SIZE });
  onscreen.contentView.addChildView(tabA);
  onscreen.focus();
  await load(tabA.webContents, `${server.url}/baseline`);
  await sleep(500);
  report.onscreenDefaults = { probe: await probe(tabA.webContents), windowIsFocused: onscreen.isFocused() };
  const rawUa = tabA.webContents.userAgent;
  const sanitized = rawUa.replace(/\sElectron\/[^\s]+/g, "");
  tabA.webContents.setUserAgent(sanitized);
  await load(tabA.webContents, `${server.url}/sanitized`);
  await sleep(400);
  report.onscreenSanitizedUa = {
    rawUa,
    sanitized,
    probe: await probe(tabA.webContents),
    windowIsFocused: onscreen.isFocused()
  };
  const parking = new import_electron.BrowserWindow({
    x: spot.x,
    y: spot.y,
    ...SIZE,
    show: false,
    frame: false,
    skipTaskbar: true,
    backgroundColor: "#123"
  });
  const tabB = new import_electron.WebContentsView({ webPreferences: { backgroundThrottling: false } });
  tabB.setBounds({ x: 0, y: 0, ...SIZE });
  parking.contentView.addChildView(tabB);
  parking.showInactive();
  await load(tabB.webContents, `${server.url}/parked`);
  onscreen.focus();
  await sleep(500);
  report.parked = {
    probe: await probe(tabB.webContents),
    parkingVisible: parking.isVisible(),
    parkingFocused: parking.isFocused(),
    parkingBounds: parking.getBounds(),
    focusedWindow: import_electron.BrowserWindow.getFocusedWindow() === onscreen ? "onscreen" : String(import_electron.BrowserWindow.getFocusedWindow()?.getTitle() ?? "none"),
    onscreenIsFocused: onscreen.isFocused()
  };
  tabB.webContents.focus();
  await sleep(600);
  report.parkedAfterWebContentsFocus = {
    probe: await probe(tabB.webContents),
    parkingFocused: parking.isFocused(),
    onscreenIsFocused: onscreen.isFocused(),
    focusedWindow: import_electron.BrowserWindow.getFocusedWindow() === onscreen ? "onscreen" : import_electron.BrowserWindow.getFocusedWindow() === parking ? "parking" : "other"
  };
  parking.focus();
  await sleep(600);
  report.parkedAfterWindowFocus = {
    probe: await probe(tabB.webContents),
    parkingFocused: parking.isFocused(),
    onscreenIsFocused: onscreen.isFocused(),
    focusedWindow: import_electron.BrowserWindow.getFocusedWindow() === onscreen ? "onscreen" : import_electron.BrowserWindow.getFocusedWindow() === parking ? "parking" : "other"
  };
  onscreen.focus();
  tabA.webContents.focus();
  await sleep(500);
  report.onscreenAgain = {
    probe: await probe(tabA.webContents),
    parked: await probe(tabB.webContents),
    onscreenIsFocused: onscreen.isFocused()
  };
  const focusedWindowName = () => {
    const focused = import_electron.BrowserWindow.getFocusedWindow();
    if (focused === onscreen) return "onscreen";
    if (focused === parking) return "parking";
    return focused ? "other" : "none";
  };
  const round2 = {};
  const dbg = tabB.webContents.debugger;
  round2.attachedBefore = dbg.isAttached();
  onscreen.focus();
  tabA.webContents.focus();
  await sleep(400);
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    round2.attached = dbg.isAttached();
    await dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await sleep(600);
    round2.focusEmulationOn = {
      probe: await probe(tabB.webContents),
      parkingFocused: parking.isFocused(),
      onscreenIsFocused: onscreen.isFocused(),
      focusedWindow: focusedWindowName()
    };
    const cleanUa = rawUa.replace(/\sElectron\/[^\s]+/g, "").replace(/\sCraftAgents\/[^\s]+/g, "");
    const brands = [
      { brand: "Not_A Brand", version: "99" },
      { brand: "Chromium", version: "142" },
      { brand: "Google Chrome", version: "142" }
    ];
    await dbg.sendCommand("Emulation.setUserAgentOverride", {
      userAgent: cleanUa,
      acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
      userAgentMetadata: {
        brands,
        fullVersionList: [
          { brand: "Not_A Brand", version: "99.0.0.0" },
          { brand: "Chromium", version: "142.0.7444.235" },
          { brand: "Google Chrome", version: "142.0.7444.235" }
        ],
        fullVersion: "142.0.7444.235",
        platform: "Windows",
        platformVersion: "19.0.0",
        architecture: "x86",
        bitness: "64",
        model: "",
        mobile: false
      }
    });
    await load(tabB.webContents, `${server.url}/cdp-ua-override`);
    await sleep(500);
    round2.uaOverride = { probe: await probe(tabB.webContents), parkingFocused: parking.isFocused() };
    dbg.detach();
    await load(tabB.webContents, `${server.url}/after-detach`);
    await sleep(500);
    round2.afterDetach = {
      probe: await probe(tabB.webContents),
      parkingFocused: parking.isFocused(),
      onscreenIsFocused: onscreen.isFocused(),
      focusedWindow: focusedWindowName()
    };
  } catch (error) {
    round2.error = String(error && error.stack ? error.stack : error);
  }
  report.round2 = round2;
  const round3 = {};
  try {
    const ses = tabB.webContents.session;
    round3.before = await probe(tabB.webContents);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    await load(tabB.webContents, `${server.url}/permission-denied`);
    await sleep(500);
    round3.denied = await probe(tabB.webContents);
  } catch (error) {
    round3.error = String(error && error.stack ? error.stack : error);
  }
  report.round3 = round3;
  const round4 = {};
  const HTTPS_ECHOES = ["https://httpbin.org/headers", "https://tls.peet.ws/api/all"];
  const wanted = /^(sec-ch-ua|user-agent|accept-language|sec-fetch)/i;
  const echoHeaders = async (wc) => {
    try {
      const text = String(await wc.executeJavaScript('document.body ? document.body.innerText : ""'));
      return text.split("\n").map((line) => line.trim().replace(/^"/, "").replace(/",?$/, "")).filter((line) => wanted.test(line));
    } catch (error) {
      return [`error: ${String(error && error.message ? error.message : error)}`];
    }
  };
  const httpsEcho = async (wc) => {
    let lastError = "no candidate";
    for (const url of HTTPS_ECHOES) {
      try {
        await load(wc, url);
        await sleep(400);
        return { url, headers: await echoHeaders(wc) };
      } catch (error) {
        lastError = String(error && error.message ? error.message : error);
      }
    }
    return { failed: lastError };
  };
  try {
    round4.todayOverHttps = await httpsEcho(tabA.webContents);
    const ses = tabA.webContents.session;
    const cleanUa = rawUa.replace(/\sElectron\/[^\s]+/g, "").replace(/\sCraftAgents\/[^\s]+/g, "");
    ses.setUserAgent(cleanUa, "zh-CN,zh;q=0.9,en;q=0.8");
    await load(tabA.webContents, `${server.url}/session-ua`);
    await sleep(400);
    const afterSessionUa = await probe(tabA.webContents);
    round4.sessionSetUserAgent = {
      ua: afterSessionUa.ua,
      languages: afterSessionUa.languages,
      brands: afterSessionUa.brands,
      fullVersionList: afterSessionUa.fullVersionList,
      localHeaders: seenHeaders.filter((header) => String(header.path) === "/session-ua")
    };
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      headers["Sec-CH-UA"] = '"Not_A Brand";v="99", "Chromium";v="142", "Google Chrome";v="142"';
      headers["Sec-CH-UA-Mobile"] = "?0";
      headers["Sec-CH-UA-Platform"] = '"Windows"';
      headers["Sec-CH-UA-Full-Version-List"] = '"Not_A Brand";v="99.0.0.0", "Chromium";v="142.0.7444.235", "Google Chrome";v="142.0.7444.235"';
      callback({ requestHeaders: headers });
    });
    await load(tabA.webContents, `${server.url}/session-ua-plus-headers`);
    await sleep(400);
    round4.ourHeadersOnHttp = seenHeaders.filter((header) => String(header.path) === "/session-ua-plus-headers");
    round4.afterWeAddHeader = await httpsEcho(tabA.webContents);
  } catch (error) {
    round4.error = String(error && error.stack ? error.stack : error);
  }
  report.round4 = round4;
  const round5 = {};
  try {
    const wc = tabA.webContents;
    const dbg2 = wc.debugger;
    let detachEvents = 0;
    dbg2.on("detach", () => {
      detachEvents++;
    });
    dbg2.attach("1.3");
    round5.attachedByUs = dbg2.isAttached();
    wc.openDevTools({ mode: "detach" });
    await sleep(1500);
    round5.afterOpeningDevTools = {
      stillAttached: dbg2.isAttached(),
      detachEvents,
      devToolsOpen: wc.isDevToolsOpened()
    };
    let reattachError = null;
    try {
      dbg2.attach("1.3");
    } catch (error) {
      reattachError = String(error && error.message ? error.message : error);
    }
    await sleep(800);
    round5.afterReattachingWhileDevToolsOpen = {
      attached: dbg2.isAttached(),
      reattachError,
      devToolsStillOpen: wc.isDevToolsOpened(),
      detachEvents
    };
    try {
      wc.closeDevTools();
    } catch {
    }
  } catch (error) {
    round5.error = String(error && error.stack ? error.stack : error);
  }
  report.round5 = round5;
  report.headers = seenHeaders;
  report.electron = { electron: process.versions.electron, chrome: process.versions.chrome, appName: import_electron.app.getName() };
  report.defaultUserAgent = import_electron.app.userAgentFallback;
  writeReport({ phase: "done", ...report });
  console.log("SPIKE_JSON " + JSON.stringify(report, null, 2));
  console.log("\n=== \u5173\u952E\u8BFB\u6570 ===");
  const rows = [
    ["onscreen(default UA)", report.onscreenDefaults?.probe],
    ["onscreen(sanitized UA)", report.onscreenSanitizedUa?.probe],
    ["parked", report.parked?.probe],
    ["parked + wc.focus()", report.parkedAfterWebContentsFocus?.probe],
    ["parked + win.focus()", report.parkedAfterWindowFocus?.probe],
    ["onscreen again", report.onscreenAgain?.probe],
    ["parked + focusEmulation", report.round2?.focusEmulationOn?.probe],
    ["parked + CDP UA override", report.round2?.uaOverride?.probe],
    ["parked + after detach", report.round2?.afterDetach?.probe]
  ];
  const keys = ["hasFocus", "visibility", "hidden", "outerWidth", "outerHeight", "screenX", "screenY", "webdriver", "chromeType", "chromeRuntime", "plugins", "notificationPermission", "permissionsState"];
  for (const [label, data] of rows) {
    const picked = {};
    for (const key of keys) picked[key] = data ? data[key] : void 0;
    console.log(label.padEnd(24) + " " + JSON.stringify(picked));
  }
  for (const [label, data] of rows) {
    console.log(label.padEnd(24) + "  ua=" + (data ? String(data.ua) : "n/a"));
    console.log("".padEnd(24) + "  brands=" + JSON.stringify(data?.brands) + " full=" + JSON.stringify(data?.fullVersionList));
  }
  console.log("\n=== \u8BF7\u6C42\u5934 ===");
  for (const header of seenHeaders) {
    console.log(JSON.stringify(header));
  }
  console.log("\n=== \u7126\u70B9\u5F52\u5C5E ===");
  console.log("after wc.focus(): " + JSON.stringify(report.parkedAfterWebContentsFocus));
  console.log("after win.focus(): " + JSON.stringify(report.parkedAfterWindowFocus));
  server.close();
  for (const win of [onscreen, parking]) if (!win.isDestroyed()) win.destroy();
  import_electron.app.quit();
}
import_electron.app.whenReady().then(() => {
  main().catch((error) => {
    console.log("SPIKE_ERROR " + (error && error.stack ? error.stack : String(error)));
    import_electron.app.exit(1);
  });
});
