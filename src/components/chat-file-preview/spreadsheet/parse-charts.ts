
import { CHART_COLORS } from './constants';
import type {
  SpreadsheetChart,
  SpreadsheetChartSeries,
  SpreadsheetSheet,
  WorkbookFileEntry,
} from './types';
import { getCellNumberValue, getCellValue, parseNumericLikeValue } from './utils';

type XmlElement = ChildNode &
  ParentNode & {
    localName: string;
    textContent: string | null;
    getAttribute(name: string): string | null;
    getElementsByTagName(name: string): ArrayLike<XmlElement>;
  };

type XmlDocument = Document & {
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
};

function decodeWorkbookFileContent(content: unknown) {
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) {
    return new TextDecoder().decode(content);
  }
  if (content instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(content));
  }
  if (
    typeof Buffer !== 'undefined' &&
    typeof Buffer.isBuffer === 'function' &&
    Buffer.isBuffer(content)
  ) {
    return content.toString('utf8');
  }
  if (ArrayBuffer.isView(content)) {
    return new TextDecoder().decode(
      new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
    );
  }
  return null;
}

function getWorkbookFileText(
  files: Record<string, WorkbookFileEntry> | undefined,
  path: string,
) {
  if (!files) return null;
  const entry = files[path];
  if (!entry) return null;
  return decodeWorkbookFileContent(entry.content);
}

function parseXmlDocument(text: string | null): XmlDocument | null {
  if (!text) return null;
  const document = new DOMParser().parseFromString(text, 'text/xml');
  if (document.querySelector('parsererror')) return null;
  return document as unknown as XmlDocument;
}

function getChildrenByLocalName(node: ParentNode, localName: string) {
  const targetName = localName.toLowerCase();
  return Array.from(node.childNodes).filter(
    (child): child is XmlElement =>
      child.nodeType === Node.ELEMENT_NODE &&
      ((child as XmlElement).localName ?? '').toLowerCase() === targetName,
  );
}

function getFirstChildByLocalName(node: ParentNode, localName: string) {
  return getChildrenByLocalName(node, localName)[0] ?? null;
}

function getDescendantsByLocalName(node: ParentNode, localName: string) {
  const targetName = localName.toLowerCase();
  return Array.from(
    (node as ParentNode & { getElementsByTagName(name: string): ArrayLike<XmlElement> })
      .getElementsByTagName('*'),
  ).filter(
    (element): element is XmlElement => (element.localName ?? '').toLowerCase() === targetName,
  );
}

function getDescendantText(node: ParentNode, localName: string) {
  const target = getDescendantsByLocalName(node, localName)[0];
  return target?.textContent?.trim() || null;
}

function columnLabelToIndex(label: string) {
  let index = 0;
  for (const character of label.toUpperCase()) {
    index = index * 26 + character.charCodeAt(0) - 64;
  }
  return index - 1;
}

function parseCellReference(address: string) {
  const match = address.replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    columnIndex: columnLabelToIndex(match[1]),
    rowIndex: Number.parseInt(match[2], 10) - 1,
  };
}

function findFormulaSheetSeparator(formula: string) {
  let inQuotedSheetName = false;
  for (let index = 0; index < formula.length; index += 1) {
    const character = formula[index];
    if (character === "'") {
      if (inQuotedSheetName && formula[index + 1] === "'") {
        index += 1;
        continue;
      }
      inQuotedSheetName = !inQuotedSheetName;
      continue;
    }
    if (character === '!' && !inQuotedSheetName) {
      return index;
    }
  }
  return -1;
}

function normalizeFormulaSheetName(sheetName: string) {
  const withoutWorkbook = sheetName.replace(/^\[[^\]]+\]/, '');
  if (withoutWorkbook.startsWith("'") && withoutWorkbook.endsWith("'")) {
    return withoutWorkbook.slice(1, -1).replace(/''/g, "'");
  }
  return withoutWorkbook;
}

function parseChartRangeFormula(formula: string, fallbackSheetName: string) {
  const trimmed = formula.trim();
  if (!trimmed) return null;
  const separatorIndex = findFormulaSheetSeparator(trimmed);
  const sheetName =
    separatorIndex >= 0
      ? normalizeFormulaSheetName(trimmed.slice(0, separatorIndex))
      : fallbackSheetName;
  const rangeText = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
  const [startAddress, endAddress = startAddress] = rangeText.split(':');
  const start = parseCellReference(startAddress);
  const end = parseCellReference(endAddress);
  if (!start || !end) return null;

  return {
    sheetName,
    startRow: Math.min(start.rowIndex, end.rowIndex),
    endRow: Math.max(start.rowIndex, end.rowIndex),
    startCol: Math.min(start.columnIndex, end.columnIndex),
    endCol: Math.max(start.columnIndex, end.columnIndex),
  };
}

function getReferenceFormula(node: XmlElement | null) {
  if (!node) return null;
  const formula = getDescendantText(node, 'f');
  return formula && formula.length > 0 ? formula : null;
}

function getSheetLookup(sheets?: SpreadsheetSheet[]) {
  if (!sheets) return null;
  return new Map(sheets.map((sheet) => [sheet.name, sheet]));
}

function getCellsForRange(
  formula: string | null,
  fallbackSheetName: string,
  sheetsByName: Map<string, SpreadsheetSheet> | null,
) {
  if (!formula || !sheetsByName) return [];
  const range = parseChartRangeFormula(formula, fallbackSheetName);
  if (!range) return [];
  const sheet = sheetsByName.get(range.sheetName);
  if (!sheet) return [];

  const cells: Array<SpreadsheetSheet['rows'][number][number] | null> = [];
  const sourceStartRow = sheet.sourceStartRow ?? 0;
  const sourceStartCol = sheet.sourceStartCol ?? 0;
  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex += 1) {
    for (let columnIndex = range.startCol; columnIndex <= range.endCol; columnIndex += 1) {
      cells.push(sheet.rows[rowIndex - sourceStartRow]?.[columnIndex - sourceStartCol] ?? null);
    }
  }
  return cells;
}

function getReferenceTextPoints(
  node: XmlElement | null,
  fallbackSheetName: string,
  sheetsByName: Map<string, SpreadsheetSheet> | null,
) {
  return getCellsForRange(getReferenceFormula(node), fallbackSheetName, sheetsByName)
    .map((cell) => getCellValue(cell).trim());
}

function getReferenceNumericPoints(
  node: XmlElement | null,
  fallbackSheetName: string,
  sheetsByName: Map<string, SpreadsheetSheet> | null,
) {
  return getCellsForRange(getReferenceFormula(node), fallbackSheetName, sheetsByName)
    .map((cell) => getCellNumberValue(cell) ?? parseNumericLikeValue(getCellValue(cell)));
}

function normalizeWorkbookPath(basePath: string, relativePath: string) {
  if (relativePath.startsWith('/')) {
    return relativePath.replace(/^\/+/, '');
  }

  const stack = basePath.split('/').filter(Boolean);
  if (!basePath.endsWith('/')) {
    stack.pop();
  }
  for (const segment of relativePath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function parseRelationships(
  files: Record<string, WorkbookFileEntry> | undefined,
  relsPath: string,
) {
  const document = parseXmlDocument(getWorkbookFileText(files, relsPath));
  if (!document) return [];
  return getDescendantsByLocalName(document, 'Relationship').flatMap((relationship) => {
    const parsed = {
      id: relationship.getAttribute('Id') || '',
      type: relationship.getAttribute('Type') || '',
      target: relationship.getAttribute('Target') || '',
    };
    return parsed.id && parsed.target ? [parsed] : [];
  });
}

function getRelationshipId(node: XmlElement) {
  return node.getAttribute('r:id') || node.getAttribute('id') || null;
}

function getRelationshipPartPath(partPath: string) {
  const lastSlashIndex = partPath.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return `_rels/${partPath}.rels`;
  }
  const directory = partPath.slice(0, lastSlashIndex);
  const filename = partPath.slice(lastSlashIndex + 1);
  return `${directory}/_rels/${filename}.rels`;
}

function getSheetPartPathsBySheetName(
  files: Record<string, WorkbookFileEntry> | undefined,
  sheetNames: string[],
) {
  const fallbackPaths = new Map(
    sheetNames.map((sheetName, index) => [sheetName, `xl/worksheets/sheet${index + 1}.xml`]),
  );
  const workbookDocument = parseXmlDocument(getWorkbookFileText(files, 'xl/workbook.xml'));
  if (!workbookDocument) return fallbackPaths;

  const sheetPartTargetsById = new Map(
    parseRelationships(files, 'xl/_rels/workbook.xml.rels').flatMap((relationship) => {
      if (!relationship.type.includes('/worksheet') && !relationship.type.includes('/chartsheet')) {
        return [];
      }
      return [[
        relationship.id,
        normalizeWorkbookPath('xl/workbook.xml', relationship.target),
      ]];
    }),
  );
  if (sheetPartTargetsById.size === 0) return fallbackPaths;

  const sheetPartPathsByName = new Map(fallbackPaths);
  for (const sheetNode of getDescendantsByLocalName(workbookDocument, 'sheet')) {
    const sheetName = sheetNode.getAttribute('name');
    const relationshipId = getRelationshipId(sheetNode);
    const sheetPartPath = relationshipId ? sheetPartTargetsById.get(relationshipId) : null;
    if (sheetName && sheetPartPath) {
      sheetPartPathsByName.set(sheetName, sheetPartPath);
    }
  }
  return sheetPartPathsByName;
}

function getCachePoints(node: XmlElement | null) {
  if (!node) return [];
  const cache =
    getDescendantsByLocalName(node, 'strCache')[0] ??
    getDescendantsByLocalName(node, 'numCache')[0] ??
    getDescendantsByLocalName(node, 'strLit')[0] ??
    getDescendantsByLocalName(node, 'numLit')[0];
  if (!cache) return [];

  const points = getChildrenByLocalName(cache, 'pt').map((point, fallbackIndex) => {
    const parsedIndex = Number.parseInt(point.getAttribute('idx') ?? '', 10);
    return {
      index: Number.isFinite(parsedIndex) && parsedIndex >= 0 ? parsedIndex : fallbackIndex,
      value: getDescendantText(point, 'v') ?? point.textContent?.trim() ?? '',
    };
  });
  if (points.length === 0) return [];

  const declaredCount = Number.parseInt(
    getFirstChildByLocalName(cache, 'ptCount')?.getAttribute('val') ?? '',
    10,
  );
  const pointCount = Math.max(
    Number.isFinite(declaredCount) && declaredCount > 0 ? declaredCount : 0,
    ...points.map((point) => point.index + 1),
  );
  const values = Array.from({ length: pointCount }, () => '');
  for (const point of points) {
    values[point.index] = point.value;
  }
  return values;
}

function getSeriesName(seriesNode: XmlElement, fallback: string) {
  const tx = getFirstChildByLocalName(seriesNode, 'tx');
  const text =
    getDescendantText(tx ?? seriesNode, 'v') ??
    getDescendantText(tx ?? seriesNode, 't');
  return text && text.length > 0 ? text : fallback;
}

function getChartTitle(chartSpace: XmlDocument, fallback: string) {
  const titleNode = getDescendantsByLocalName(chartSpace, 'title')[0];
  if (!titleNode) return fallback;
  const textParts = getDescendantsByLocalName(titleNode, 't').flatMap((node) => {
    const value = node.textContent?.trim() ?? '';
    return value.length > 0 ? [value] : [];
  });
  return textParts.length > 0 ? textParts.join(' ') : fallback;
}

function parseEmbeddedChartNode(
  chartNode: XmlElement,
  chartFile: string,
  sheetName: string,
  sheetsByName: Map<string, SpreadsheetSheet> | null,
) {
  const seriesNodes = getChildrenByLocalName(chartNode, 'ser');
  if (seriesNodes.length === 0) return null;

  const kindMap: Record<string, SpreadsheetChart['kind']> = {
    barChart: 'bar',
    bar3DChart: 'bar',
    lineChart: 'line',
    line3DChart: 'line',
    areaChart: 'line',
    area3DChart: 'line',
    pieChart: 'pie',
    pie3DChart: 'pie',
    doughnutChart: 'doughnut',
  };

  const chartKind = kindMap[chartNode.localName] ?? 'line';
  const primaryCategoryNode = getFirstChildByLocalName(seriesNodes[0], 'cat');
  const fallbackCategoryNode = getFirstChildByLocalName(seriesNodes[0], 'xVal');
  const primaryCategories = getCachePoints(primaryCategoryNode);
  const categories =
    primaryCategories.length > 0
      ? primaryCategories
      : getCachePoints(fallbackCategoryNode);
  const resolvedCategories =
    categories.length > 0
      ? categories
      : getReferenceTextPoints(primaryCategoryNode ?? fallbackCategoryNode, sheetName, sheetsByName);
  if (resolvedCategories.length === 0) return null;

  const series = seriesNodes
    .map((seriesNode, index) => {
      const valueNode =
        getFirstChildByLocalName(seriesNode, 'val') ??
        getFirstChildByLocalName(seriesNode, 'yVal');
      const cachedValues = getCachePoints(valueNode).map((value) => parseNumericLikeValue(value));
      const values =
        cachedValues.some((value) => value !== null)
          ? cachedValues
          : getReferenceNumericPoints(valueNode, sheetName, sheetsByName);
      if (values.every((value) => value === null)) {
        return null;
      }
      return {
        name: getSeriesName(seriesNode, `Series ${index + 1}`),
        values,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0],
      };
    })
    .filter((series): series is SpreadsheetChartSeries => Boolean(series));

  if (series.length === 0) return null;

  const categoryLabel =
    chartKind === 'pie' || chartKind === 'doughnut' ? 'Slice' : 'Category';

  return {
    id: `${sheetName}:${chartFile}:${chartKind}`,
    kind: chartKind,
    title: `${sheetName} chart`,
    sheetName,
    categoryLabel,
    categories: resolvedCategories,
    series,
    source: 'embedded' as const,
  };
}

export function extractEmbeddedChartsFromWorkbookFiles(
  files: Record<string, WorkbookFileEntry> | undefined,
  sheetNames: string[],
  sheets?: SpreadsheetSheet[],
) {
  if (!files || sheetNames.length === 0) return [] as SpreadsheetChart[];

  const sheetsByName = getSheetLookup(sheets);
  const chartPathsBySheet = new Map<string, Set<string>>();
  const sheetPartPathsBySheetName = getSheetPartPathsBySheetName(files, sheetNames);

  sheetNames.forEach((sheetName) => {
    const sheetPartPath = sheetPartPathsBySheetName.get(sheetName);
    if (!sheetPartPath) return;
    const sheetRelsPath = getRelationshipPartPath(sheetPartPath);
    const drawingRelationships = parseRelationships(files, sheetRelsPath).filter((relationship) =>
      relationship.type.includes('/drawing'),
    );
    for (const drawingRelationship of drawingRelationships) {
      const drawingPath = normalizeWorkbookPath(
        sheetPartPath,
        drawingRelationship.target,
      );
      const drawingRelsPath = getRelationshipPartPath(drawingPath);
      const chartRelationships = parseRelationships(files, drawingRelsPath).filter((relationship) =>
        relationship.type.includes('/chart'),
      );
      for (const chartRelationship of chartRelationships) {
        const chartPath = normalizeWorkbookPath(drawingPath, chartRelationship.target);
        const existing = chartPathsBySheet.get(sheetName) ?? new Set<string>();
        existing.add(chartPath);
        chartPathsBySheet.set(sheetName, existing);
      }
    }
  });

  const charts: SpreadsheetChart[] = [];

  for (const [sheetName, chartPaths] of chartPathsBySheet) {
    for (const chartPath of chartPaths) {
      const document = parseXmlDocument(getWorkbookFileText(files, chartPath));
      if (!document) continue;
      const chartNode =
        getDescendantsByLocalName(document, 'barChart')[0] ??
        getDescendantsByLocalName(document, 'bar3DChart')[0] ??
        getDescendantsByLocalName(document, 'lineChart')[0] ??
        getDescendantsByLocalName(document, 'line3DChart')[0] ??
        getDescendantsByLocalName(document, 'pieChart')[0] ??
        getDescendantsByLocalName(document, 'pie3DChart')[0] ??
        getDescendantsByLocalName(document, 'doughnutChart')[0] ??
        getDescendantsByLocalName(document, 'areaChart')[0] ??
        getDescendantsByLocalName(document, 'area3DChart')[0];
      if (!chartNode) continue;
      const parsedChart = parseEmbeddedChartNode(chartNode, chartPath, sheetName, sheetsByName);
      if (!parsedChart) {
        console.warn('Skipping embedded Excel chart without renderable data', {
          chartPath,
          sheetName,
        });
        continue;
      }
      parsedChart.title = getChartTitle(document, parsedChart.title);
      charts.push(parsedChart);
    }
  }

  return charts;
}
