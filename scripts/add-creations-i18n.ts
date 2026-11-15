/**
 * Add the `creations.*` strings to every locale.
 *
 * The locale files are flat, alphabetically sorted JSON — so the safe way to add a key is to parse,
 * merge, and write back sorted. Doing it by hand in seven files is how one of them ends up missing a
 * key and the parity check fails a week later.
 *
 *   bun scripts/add-creations-i18n.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LOCALES = resolve(import.meta.dir, '..', 'packages', 'shared', 'src', 'i18n', 'locales')

type Strings = Record<string, string>

// Every key is fully prefixed. An unprefixed `refresh` here is what produced four keys nobody
// asked for — `t('creations.refresh')` resolved to the key itself, and the coverage check caught it.
const common = {
  'creations.refresh': 'Rescan',
  'creations.allFormats': 'All',
  'creations.placeAll': 'All',
  'creations.search': 'Filter by path',
}

const TRANSLATIONS: Record<string, Strings> = {
  en: {
    'sidebar.creations': 'Creations',
    'creations.title': 'Creations',
    'creations.subtitle': '{{works}} works · from {{sessions}} conversations',
    'creations.placeSession': 'conversation',
    'creations.placeProject': 'project',
    'creations.placeOther': 'elsewhere',
    'creations.emptyTitle': 'Nothing made yet',
    'creations.emptyBody':
      'When the agent writes a document in a conversation, it appears here with the turn that produced it. Open one to read or edit it in its own editor.',
    'creations.openSource': 'Open the conversation that made this',
    'creations.gone': 'gone',
    'creations.versions': 'Versions',
    'creations.versionsSubtitle': 'What this looked like before',
    'creations.versionsEmpty': 'No earlier versions yet',
    'creations.saveVersion': 'Save this version…',
    'creations.versionSaved': 'Version saved to {{path}}',
    'creations.versionFailed': 'That version could not be saved',
    ...common,
  },
  'zh-Hans': {
    'sidebar.creations': '产物',
    'creations.title': '产物',
    'creations.subtitle': '{{works}} 个产物 · 来自 {{sessions}} 个对话',
    'creations.placeSession': '会话产出',
    'creations.placeProject': '项目',
    'creations.placeOther': '工作区外',
    'creations.emptyTitle': '还没有产出',
    'creations.emptyBody':
      '当智能体在对话里写出文档，它会带着产出它的那一轮出现在这里。打开一个就能用对应的编辑器阅读或修改。',
    'creations.openSource': '打开产出它的对话',
    'creations.gone': '已不在',
    'creations.versions': '历史版本',
    'creations.versionsSubtitle': '它之前的样子',
    'creations.versionsEmpty': '还没有更早的版本',
    'creations.saveVersion': '另存这个版本…',
    'creations.versionSaved': '已保存到 {{path}}',
    'creations.versionFailed': '这个版本保存失败',
    refresh: '重新扫描',
    allFormats: '全部',
    placeAll: '全部',
    search: '按路径筛选',
  },
  ja: {
    'sidebar.creations': '作品',
    'creations.title': '作品',
    'creations.subtitle': '{{works}} 件 · {{sessions}} 件の会話から',
    'creations.placeSession': '会話の成果',
    'creations.placeProject': 'プロジェクト',
    'creations.placeOther': 'ワークスペース外',
    'creations.emptyTitle': 'まだ何も作られていません',
    'creations.emptyBody':
      'エージェントが会話の中で文書を書くと、それを作ったターンとともにここに並びます。開けばその形式のエディタで読んだり直したりできます。',
    'creations.openSource': 'これを作った会話を開く',
    'creations.gone': '見つかりません',
    'creations.versions': '履歴',
    'creations.versionsSubtitle': '以前の状態',
    'creations.versionsEmpty': 'まだ以前の版はありません',
    'creations.saveVersion': 'この版を保存…',
    'creations.versionSaved': '{{path}} に保存しました',
    'creations.versionFailed': 'この版を保存できませんでした',
    refresh: '再スキャン',
    allFormats: 'すべて',
    placeAll: 'すべて',
    search: 'パスで絞り込む',
  },
  de: {
    'sidebar.creations': 'Werke',
    'creations.title': 'Werke',
    'creations.subtitle': '{{works}} Werke · aus {{sessions}} Unterhaltungen',
    'creations.placeSession': 'Unterhaltung',
    'creations.placeProject': 'Projekt',
    'creations.placeOther': 'außerhalb',
    'creations.emptyTitle': 'Noch nichts erstellt',
    'creations.emptyBody':
      'Wenn der Agent in einer Unterhaltung ein Dokument schreibt, erscheint es hier — zusammen mit dem Zug, der es erzeugt hat. Öffnen zeigt es im passenden Editor.',
    'creations.openSource': 'Die Unterhaltung öffnen, die das erzeugt hat',
    'creations.gone': 'fehlt',
    'creations.versions': 'Versionen',
    'creations.versionsSubtitle': 'So sah es vorher aus',
    'creations.versionsEmpty': 'Noch keine früheren Versionen',
    'creations.saveVersion': 'Diese Version speichern…',
    'creations.versionSaved': 'Version gespeichert unter {{path}}',
    'creations.versionFailed': 'Diese Version konnte nicht gespeichert werden',
    refresh: 'Neu einlesen',
    allFormats: 'Alle',
    placeAll: 'Alle',
    search: 'Nach Pfad filtern',
  },
  es: {
    'sidebar.creations': 'Obras',
    'creations.title': 'Obras',
    'creations.subtitle': '{{works}} obras · de {{sessions}} conversaciones',
    'creations.placeSession': 'conversación',
    'creations.placeProject': 'proyecto',
    'creations.placeOther': 'fuera',
    'creations.emptyTitle': 'Todavía no hay nada',
    'creations.emptyBody':
      'Cuando el agente escribe un documento en una conversación, aparece aquí con el turno que lo produjo. Ábrelo para leerlo o editarlo en su propio editor.',
    'creations.openSource': 'Abrir la conversación que lo creó',
    'creations.gone': 'ausente',
    'creations.versions': 'Versiones',
    'creations.versionsSubtitle': 'Cómo era antes',
    'creations.versionsEmpty': 'Todavía no hay versiones anteriores',
    'creations.saveVersion': 'Guardar esta versión…',
    'creations.versionSaved': 'Versión guardada en {{path}}',
    'creations.versionFailed': 'No se pudo guardar esa versión',
    refresh: 'Volver a escanear',
    allFormats: 'Todo',
    placeAll: 'Todo',
    search: 'Filtrar por ruta',
  },
  pl: {
    'sidebar.creations': 'Prace',
    'creations.title': 'Prace',
    'creations.subtitle': '{{works}} prac · z {{sessions}} rozmów',
    'creations.placeSession': 'rozmowa',
    'creations.placeProject': 'projekt',
    'creations.placeOther': 'poza',
    'creations.emptyTitle': 'Nic jeszcze nie powstało',
    'creations.emptyBody':
      'Gdy agent napisze dokument w rozmowie, pojawi się tutaj razem z turą, która go utworzyła. Otwórz go, aby przeczytać lub zmienić w jego edytorze.',
    'creations.openSource': 'Otwórz rozmowę, która to utworzyła',
    'creations.gone': 'brak',
    'creations.versions': 'Wersje',
    'creations.versionsSubtitle': 'Jak to wyglądało wcześniej',
    'creations.versionsEmpty': 'Nie ma jeszcze wcześniejszych wersji',
    'creations.saveVersion': 'Zapisz tę wersję…',
    'creations.versionSaved': 'Zapisano wersję w {{path}}',
    'creations.versionFailed': 'Nie udało się zapisać tej wersji',
    refresh: 'Skanuj ponownie',
    allFormats: 'Wszystko',
    placeAll: 'Wszystko',
    search: 'Filtruj po ścieżce',
  },
  hu: {
    'sidebar.creations': 'Alkotások',
    'creations.title': 'Alkotások',
    'creations.subtitle': '{{works}} alkotás · {{sessions}} beszélgetésből',
    'creations.placeSession': 'beszélgetés',
    'creations.placeProject': 'projekt',
    'creations.placeOther': 'máshol',
    'creations.emptyTitle': 'Még semmi sem készült',
    'creations.emptyBody':
      'Amikor az ügynök dokumentumot ír egy beszélgetésben, itt jelenik meg azzal a körrel, amely létrehozta. Megnyitva a saját szerkesztőjében olvasható vagy módosítható.',
    'creations.openSource': 'A létrehozó beszélgetés megnyitása',
    'creations.gone': 'hiányzik',
    'creations.versions': 'Verziók',
    'creations.versionsSubtitle': 'Így nézett ki korábban',
    'creations.versionsEmpty': 'Még nincsenek korábbi verziók',
    'creations.saveVersion': 'Verzió mentése…',
    'creations.versionSaved': 'A verzió mentve: {{path}}',
    'creations.versionFailed': 'A verzió mentése nem sikerült',
    refresh: 'Újraszkennelés',
    allFormats: 'Mind',
    placeAll: 'Mind',
    search: 'Szűrés útvonalra',
  },
}

for (const [locale, strings] of Object.entries(TRANSLATIONS)) {
  const file = join(LOCALES, `${locale}.json`)
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  const missing = Object.keys(strings).filter((key) => !(key in parsed)).length
  Object.assign(parsed, strings)
  const sorted = Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
  console.log(`${locale}: +${missing} keys (${Object.keys(sorted).length} total)`)
}
