# 术语与文案规范（Craft Agents）

> 覆盖：这套代码里"东西叫什么"的规矩——浏览器这一条线（tab / 地址 / page / HTML）、那个窗口的名字、以及给用户看的文案怎么写。适用于代码标识符、注释、开发者文档，以及所有应用内可见的文案。
> 配套文档：[渲染层的导入边界](renderer-imports.md)、[项目分层开发文档](project-layers.md)、[开发环境运行指南](dev-environment.md)

## 1. 浏览器这条线：窗口装 tab，tab 拿地址，显示的才叫 page

**一句话：`page` 只指"浏览器显示出来的那份东西"；别的四样各有各的词——窗口里的一格是 `tab`，交给它的输入是 `地址/URL`，盘上的是 `文件`，app 自己画的是 `HTML`。**

| 说的是 | 用 | 不用 |
|---|---|---|
| 浏览器窗口里的一格（`tabs` / `tab-new` / `tab-assign` / `windowWithTab`） | **tab** | page |
| 交给窗口去加载的东西（`http:` / `https:`） | **地址 / URL**（`isBrowserUrl`） | page（"这个 page 能不能进窗口"读起来像 page 进 page） |
| 浏览器里显示出来的那份东西（`capturePage`、the page's viewport、the page area） | **page** | ——（这是它唯一该出现的地方） |
| 盘上的 `.html` | **HTML 文件 / 这个文件** | 页面、这一页 |
| app 自己画 HTML 的那个窗口（`HTMLPreviewOverlay`、`html-preview` 块） | **HTML 预览（窗口）** | 页面、浏览器、浏览器窗口 |
| 那颗按钮（`preview.openInBrowser`） | **Open in browser** | Open page |

判据：**先问"这是浏览器显示的对象，还是加载它的地址 / 装它的 tab / 盘上的文件 / app 画的 HTML？"** 只有第一种能用 page。

中文同理：不要用"页面"指一条链接、一个 `.html` 文件，或任何"要去浏览器打开的东西"。**例外是界面屏幕**——"详情页""设置页"里的"页"是 app 自己的一屏（`ProjectInfoPage`、`AppSettingsPage`），不是浏览器里的 page，照旧用。

## 2. 为什么：这个词在这份代码库里有三个前身

1. **原型曾经有 `pages/<name>.html` 那一档**（已删）。"页面"是它当年的名字，所以读到"页面"时读者会先想到原型。
2. **Websites 这个功能一度就叫 "Pages"**（后来改名）。同一个词换过一次所指。
3. **`isPageUrl` 曾把"地址"和"页"压成一个词**：它其实只问 scheme（是不是 http/https），与你打不打算把它显示成什么无关。现在叫 `isBrowserUrl`。

外加一条：`page` 在浏览器侧本来就有精确含义（Electron 的 `capturePage`、"the page's viewport"）。两种含义并存时，读代码的人只能靠猜，而猜错的代价是实打实的——例如界面文案写成 "Open pages in the app's browser" 之后，"浏览器装 page"读起来像窗口的输入是 page，而它的输入是地址。

## 3. 那个窗口不叫"画布"

它是**工作区的浏览器窗口**：一个工作区一个，工作区里的每个对话和每个人都用它，**通用任务（查资料、填表、看后台）也用它**——跟某一个具体功能没有必然关系。

窗口的**身份是作用域**（工作区 vs 会话），不是用途。所以代码里**没有** `isCanvas` 这样的字段：解析"这个对话在哪个窗口干活"的是 `resolveWorkspaceWindow` / `resolveWorkspaceWindowId`（[SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L3738)），注释一律写 "the workspace's window"；助手的 `tabs` 输出里 `belongs to:` / `driven by:` 谈的都是**tab**，窗口本身不署任何会话的名——那才是一个工作区只留一个窗口还能让多个对话并用的前提。

判据：**问"通用任务会不会用到它"。** 会用到的，就不能用某一个功能自己的名字 / 画布的一套词。

## 4. 给用户看的文案：说人话，不面向开发过程

- 不用实现动词：记录 / 绑定 / 解析 / 注入 / 落盘。
- 不在界面上解释机制。反例："这是背景信息，类似已连接的数据源，不是绑定"——用户不提，他也不会这样想。
- 不把代码或文档里已有的规则在界面上再念一遍。反例："要说清楚是哪一个，或者给这次对话绑定一个"——旁边的按钮已经在做这件事。

判据：**这句话是给"正在用这个界面的人"看的，还是给"读代码的人"看的？** 后者不该出现在界面上。

改过的例子（作为口径的参照）：

| 位置 | 改前 | 改后 |
|---|---|---|
| `chat.modeTooltip` | 一整段解释（这个开关会往系统提示里注入一段规则、把会话所属项目的文件夹告诉 agent…） | "What this conversation is working on." |
| `settings.links.openInAppBrowser` | "Open pages in the app's browser" | "Open links in the app's browser" |

范围：应用内可见文案——标签、说明、按钮、空态、toast。**提示词、开发者文档、代码注释不适用**：那里要的是精确的规则与理由，不要拿这一条去砍它们。

## 5. 现状：没有自动守卫

没有术语 lint，也没有文案风格校验，**这份文档是约定唯一的载体**。可行的补法是一小段自定义检查（对渲染层与 i18n 的 `en.json` 过一遍禁词表），**未做**。

自查就是按上面的判据读一遍；两个起点：

```powershell
# 浏览器语境里的 page：合法的很多（capturePage / the page's …），看上下文筛
rg -n "\bpages?\b" apps/electron/src packages/ui/src packages/server-core/src --glob '!**/__tests__/**'

# 中文文档里的"页面"：只有"详情页 / 设置页"这类界面屏幕才该留下
rg -n "页面" docs apps/electron/resources/docs
```
