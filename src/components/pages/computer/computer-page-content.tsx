'use client';

import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTheme } from 'next-themes';
import type { Monaco } from '@monaco-editor/react';
import { loader } from '@monaco-editor/react';
import type * as monacoEditor from 'monaco-editor';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  File,
  FileQuestion,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Search,
  X,
} from 'lucide-react';

import { useAuthData } from '@/hooks/use-auth-data';
import { cn } from '@/lib/utils';
import type { WorkspaceFileRead, WorkspaceListResponse } from '@/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Separator } from '@/components/ui/separator';

loader.config({ paths: { vs: '/monaco/vs' } });

const MonacoEditor = lazy(() =>
  import('@monaco-editor/react').then((mod) => ({ default: mod.default }))
);

const MonacoDiffEditor = lazy(() =>
  import('@monaco-editor/react').then((mod) => ({ default: mod.DiffEditor }))
);

const EditorLoadingFallback = () => (
  <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
    Loading editor...
  </div>
);

interface ComputerPageContentProps {
  workspaceId: string;
  readOnly?: boolean;
}

type FsNode = {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  children: string[];
  isLoaded: boolean;
  size?: number;
  modifiedAt?: string;
};

type OpenTab = {
  path: string;
  title: string;
  isDirty: boolean;
  isBinary?: boolean;
  isTooLarge?: boolean;
  notFound?: boolean;
  version?: string;
};

type TreeRow = {
  node: FsNode;
  depth: number;
  isMatch: boolean;
};

type DialogState =
  | { type: 'new-file'; parentPath: string }
  | { type: 'new-folder'; parentPath: string }
  | { type: 'rename'; path: string }
  | { type: 'delete'; path: string; kind: 'file' | 'dir' }
  | null;

type ConflictState = {
  path: string;
  localContent: string;
  remoteContent: string;
  remoteVersion: string;
};

type WorkspaceFileReadPayload = Partial<WorkspaceFileRead> & {
  success?: boolean;
  error?: string;
  code?: string;
};

const ROOT_PATH = '/';
const WORKSPACE_ROOT_PREFIXES = ['/home/claude', '/workspace', '/root'];
const MAX_EDITABLE_BYTES = 1024 * 1024;
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const BETA_FILE_EDIT_DISABLED_MESSAGE = 'File editing is disabled during beta.';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  sh: 'shell',
  zsh: 'shell',
  toml: 'toml',
};

const ICON_BY_EXTENSION: Record<string, ComponentType<{ className?: string }>> = {
  ts: FileCode2,
  tsx: FileCode2,
  js: FileCode2,
  jsx: FileCode2,
  json: FileJson,
  md: FileText,
  mdx: FileText,
  css: FileCode2,
  scss: FileCode2,
  html: FileCode2,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  mp3: FileAudio,
  wav: FileAudio,
  mp4: FileVideo,
  mov: FileVideo,
  zip: FileArchive,
  gz: FileArchive,
  tar: FileArchive,
};

function normalizePath(input?: string): string {
  if (!input) return ROOT_PATH;
  let raw = input.trim();
  if (!raw.startsWith('/')) raw = `/${raw}`;

  const segments: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `/${segments.join('/')}` || ROOT_PATH;
}

function coerceWorkspacePath(input?: string): string {
  if (!input) return ROOT_PATH;
  const normalized = normalizePath(input);
  for (const prefix of WORKSPACE_ROOT_PREFIXES) {
    if (normalized === prefix) return ROOT_PATH;
    if (normalized.startsWith(`${prefix}/`)) {
      return normalizePath(normalized.slice(prefix.length));
    }
  }
  return normalized;
}

function joinPath(base: string, child: string): string {
  if (!child) return normalizePath(base);
  const basePath = normalizePath(base);
  const suffix = child.startsWith('/') ? child : `/${child}`;
  return normalizePath(`${basePath}${suffix}`);
}

function getBasename(path: string): string {
  if (path === ROOT_PATH) return 'workspace';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function getParentPath(path: string): string {
  if (path === ROOT_PATH) return ROOT_PATH;
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 1 ? ROOT_PATH : `/${parts.slice(0, -1).join('/')}`;
}

function getExtension(path: string): string {
  const name = getBasename(path);
  const index = name.lastIndexOf('.');
  if (index <= 0) return '';
  return name.slice(index + 1).toLowerCase();
}

function getRelativePath(path: string): string {
  if (path === ROOT_PATH) return '.';
  return path.replace(/^\/+/, '');
}

function hashString(value: string | null | undefined): string {
  const input = typeof value === 'string' ? value : '';
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function isReadNotFoundError(payload: WorkspaceFileReadPayload | null): boolean {
  if (payload?.code === 'ENOENT') return true;
  const errorMessage =
    typeof payload?.error === 'string' ? payload.error.toLowerCase() : '';
  return errorMessage.includes('not found') || errorMessage.includes('enoent');
}

function toWorkspaceFileRead(
  payload: WorkspaceFileReadPayload | null,
  fallbackPath: string
): WorkspaceFileRead {
  return {
    path: typeof payload?.path === 'string' ? payload.path : fallbackPath,
    content: typeof payload?.content === 'string' ? payload.content : '',
    version: typeof payload?.version === 'string' ? payload.version : '',
    size: typeof payload?.size === 'number' ? payload.size : null,
    mtime: typeof payload?.mtime === 'string' ? payload.mtime : null,
    isBinary: payload?.isBinary === true,
    encoding: payload?.encoding === 'base64' ? 'base64' : 'utf-8',
    mimeType: typeof payload?.mimeType === 'string' ? payload.mimeType : null,
  };
}

function canDropInto(targetPath: string, sourcePath: string): boolean {
  const normalizedTarget = normalizePath(targetPath);
  const normalizedSource = normalizePath(sourcePath);
  if (normalizedTarget === normalizedSource) return false;
  if (normalizedTarget.startsWith(`${normalizedSource}/`)) return false;
  return true;
}

function getLanguageForPath(path: string): string {
  const ext = getExtension(path);
  return LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext';
}

function getFileIcon(path: string): React.ComponentType<{ className?: string }> {
  const ext = getExtension(path);
  return ICON_BY_EXTENSION[ext] ?? File;
}

export default function ComputerPageContent({
  workspaceId,
  readOnly = false,
}: ComputerPageContentProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { resolvedTheme } = useTheme();
  const { user, currentWorkspace } = useAuthData();

  const apiBase = useMemo(() => `/api/workspaces/${workspaceId}/fs`, [workspaceId]);
  const storageKey = useMemo(() => `workspace:${workspaceId}:ide-state`, [workspaceId]);

  const [nodesByPath, setNodesByPath] = useState<Record<string, FsNode>>({
    [ROOT_PATH]: {
      path: ROOT_PATH,
      name: 'workspace',
      kind: 'dir',
      children: [],
      isLoaded: false,
    },
  });
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set([ROOT_PATH])
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchIndexLoaded, setSearchIndexLoaded] = useState(false);
  const [searchIndexAttempted, setSearchIndexAttempted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [dragBlockedPath, setDragBlockedPath] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [dialogName, setDialogName] = useState('');
  const [dialogSubmitting, setDialogSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [savingPaths, setSavingPaths] = useState<Set<string>>(new Set());
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [rootLoaded, setRootLoaded] = useState(false);
  const [monacoReady, setMonacoReady] = useState(false);
  const [readOnlyHintOpen, setReadOnlyHintOpen] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());
  const [uploadTargetPath, setUploadTargetPath] = useState<string>(ROOT_PATH);

  const monacoRef = useRef<Monaco | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);
  const editorDisposedRef = useRef(true);
  const modelsRef = useRef<Map<string, monacoEditor.editor.ITextModel>>(new Map());
  const modelDisposablesRef = useRef<Map<string, monacoEditor.IDisposable>>(
    new Map()
  );
  const savedHashesRef = useRef<Map<string, string>>(new Map());
  const versionsRef = useRef<Map<string, string>>(new Map());
  const pendingModelsRef = useRef<Map<string, { content: string; language: string }>>(
    new Map()
  );
  const activePathRef = useRef<string | null>(null);
  const dragSourcePathRef = useRef<string | null>(null);
  const dragOverPathRef = useRef<string | null>(null);
  const dragExpandPathRef = useRef<string | null>(null);
  const dragExpandTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragBlockedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveFileRef = useRef<(path: string, force?: boolean) => Promise<void>>(
    async () => {}
  );
  const restoredTabsRef = useRef(false);
  const openingFilesRef = useRef<Set<string>>(new Set());
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const readOnlyHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFileHandledRef = useRef<string | null>(null);
  const canMutate = false; // File editing disabled during beta.

  const copyToClipboard = useCallback(async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    } catch (error) {
      console.warn('Failed to copy to clipboard', error);
    }
  }, []);

  const showReadOnlyHint = useCallback(() => {
    setReadOnlyHintOpen(true);
    if (readOnlyHintTimeoutRef.current) {
      clearTimeout(readOnlyHintTimeoutRef.current);
    }
    readOnlyHintTimeoutRef.current = setTimeout(() => {
      setReadOnlyHintOpen(false);
    }, 2000);
  }, []);

  // Redirect if viewing a different workspace than current
  useEffect(() => {
    if (readOnly) return;
    if (currentWorkspace?.id && currentWorkspace.id !== workspaceId) {
      navigate(`/computer/${currentWorkspace.id}`);
    }
  }, [currentWorkspace?.id, workspaceId, navigate, readOnly]);

  useEffect(() => {
    if (!hydrated || readOnly) return;
    const uniqueTabs = Array.from(new Set(openTabs.map((tab) => tab.path)));
    const data = {
      openTabs: uniqueTabs,
      activePath,
    };
    localStorage.setItem(storageKey, JSON.stringify(data));
  }, [openTabs, activePath, hydrated, storageKey, readOnly]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    return () => {
      if (readOnlyHintTimeoutRef.current) {
        clearTimeout(readOnlyHintTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    dragOverPathRef.current = dragOverPath;
  }, [dragOverPath]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as {
          expandedPaths?: string[];
          openTabs?: string[];
          activePath?: string;
        };
        if (Array.isArray(parsed.openTabs)) {
          const uniquePaths = Array.from(
            new Set(parsed.openTabs.filter((path): path is string => typeof path === 'string'))
          );
          setOpenTabs(
            uniquePaths.map((path) => ({
              path,
              title: getBasename(path),
              isDirty: false,
            }))
          );
        }
        if (typeof parsed.activePath === 'string') {
          setActivePath(parsed.activePath);
        }
      } catch (error) {
        console.warn('Failed to parse workspace IDE state', error);
      }
    }
    setHydrated(true);
  }, [storageKey, readOnly]);


  const clearDragState = useCallback(() => {
    setIsDragging(false);
    setDragOverPath(null);
    dragSourcePathRef.current = null;
    dragOverPathRef.current = null;
    dragExpandPathRef.current = null;
    if (dragExpandTimeoutRef.current) {
      clearTimeout(dragExpandTimeoutRef.current);
      dragExpandTimeoutRef.current = null;
    }
  }, []);

  const triggerDragBlocked = useCallback((path: string) => {
    setDragBlockedPath(path);
    if (dragBlockedTimeoutRef.current) {
      clearTimeout(dragBlockedTimeoutRef.current);
    }
    dragBlockedTimeoutRef.current = setTimeout(() => {
      setDragBlockedPath(null);
      dragBlockedTimeoutRef.current = null;
    }, 1400);
  }, []);


  const applyListing = useCallback((listing: WorkspaceListResponse) => {
    setNodesByPath((prev) => {
      const next = { ...prev };
      const parentPath = normalizePath(listing.path);
      const parentNode = next[parentPath] ?? {
        path: parentPath,
        name: getBasename(parentPath),
        kind: 'dir',
        children: [],
        isLoaded: false,
      };

      const childPaths: string[] = [];
      listing.entries.forEach((entry) => {
        const entryPath = normalizePath(entry.path);
        const kind = entry.type === 'directory' ? 'dir' : 'file';
        const existing = next[entryPath];
        next[entryPath] = {
          path: entryPath,
          name: entry.name,
          kind,
          children: existing?.children ?? [],
          isLoaded: existing?.isLoaded ?? false,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
        };
        childPaths.push(entryPath);
      });

      parentNode.children = childPaths;
      parentNode.isLoaded = true;
      next[parentPath] = parentNode;

      if (!next[ROOT_PATH]) {
        next[ROOT_PATH] = {
          path: ROOT_PATH,
          name: 'workspace',
          kind: 'dir',
          children: [],
          isLoaded: false,
        };
      }

      return next;
    });
  }, []);

  const applyRecursiveListing = useCallback((listing: WorkspaceListResponse) => {
    setNodesByPath((prev) => {
      const next = { ...prev };
      const childrenByParent = new Map<string, Set<string>>();
      const directories = new Set<string>();

      const ensureDirNode = (path: string) => {
        if (!next[path]) {
          next[path] = {
            path,
            name: getBasename(path),
            kind: 'dir',
            children: [],
            isLoaded: false,
          };
        }
      };

      ensureDirNode(ROOT_PATH);

      listing.entries.forEach((entry) => {
        const entryPath = normalizePath(entry.path);
        const kind = entry.type === 'directory' ? 'dir' : 'file';
        const existing = next[entryPath];
        next[entryPath] = {
          path: entryPath,
          name: entry.name,
          kind,
          children: existing?.children ?? [],
          isLoaded: kind === 'dir' ? true : existing?.isLoaded ?? false,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
        };
        if (kind === 'dir') {
          directories.add(entryPath);
        }

        const parentPath = getParentPath(entryPath);
        ensureDirNode(parentPath);
        const children = childrenByParent.get(parentPath) ?? new Set<string>();
        children.add(entryPath);
        childrenByParent.set(parentPath, children);
      });

      const ensureChildren = (parentPath: string, children?: Set<string>) => {
        const node = next[parentPath] ?? {
          path: parentPath,
          name: getBasename(parentPath),
          kind: 'dir',
          children: [],
          isLoaded: false,
        };
        node.children = children ? Array.from(children) : [];
        node.isLoaded = true;
        next[parentPath] = node;
      };

      childrenByParent.forEach((children, parentPath) => {
        ensureChildren(parentPath, children);
      });

      directories.forEach((dirPath) => {
        if (!childrenByParent.has(dirPath)) {
          ensureChildren(dirPath);
        }
      });

      return next;
    });
  }, []);

  const loadDirectory = useCallback(
    async (
      path: string,
      options: {
        recursive?: boolean;
        includeHidden?: boolean;
        timeoutMs?: number;
      } = {}
    ) => {
      const targetPath = normalizePath(path);
      const controller = options.timeoutMs ? new AbortController() : null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.add(targetPath);
        return next;
      });

      try {
        if (controller && options.timeoutMs) {
          timeoutId = setTimeout(() => {
            controller.abort();
          }, options.timeoutMs);
        }

        const query = new URLSearchParams({
          path: targetPath,
          recursive: options.recursive ? '1' : '0',
        });
        if (options.includeHidden !== undefined) {
          query.set('includeHidden', options.includeHidden ? '1' : '0');
        }

        const res = await fetch(`${apiBase}/list?${query.toString()}`, {
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!res.ok) {
          const payload = (await res
            .json()
            .catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || 'Failed to load workspace files');
        }
        const data = (await res.json()) as WorkspaceListResponse;
        if (options.recursive) {
          applyRecursiveListing(data);
        } else {
          applyListing(data);
        }
        setTreeError(null);
        return true;
      } catch (error) {
        const didTimeout = controller?.signal.aborted === true && Boolean(options.timeoutMs);
        setTreeError(
          didTimeout
            ? 'Search indexing timed out. Try narrowing your query or refreshing the file tree.'
            : error instanceof Error
            ? error.message
            : 'Failed to load workspace files'
        );
        return false;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(targetPath);
          return next;
        });
      }
    },
    [apiBase, applyListing, applyRecursiveListing]
  );

  const scheduleAutoExpand = useCallback(
    (path: string) => {
      if (expandedPaths.has(path)) return;
      if (dragExpandPathRef.current === path && dragExpandTimeoutRef.current) {
        return;
      }
      if (dragExpandTimeoutRef.current) {
        clearTimeout(dragExpandTimeoutRef.current);
        dragExpandTimeoutRef.current = null;
      }
      dragExpandPathRef.current = path;
      dragExpandTimeoutRef.current = setTimeout(async () => {
        if (dragOverPathRef.current !== path) return;
        await loadDirectory(path);
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.add(path);
          return next;
        });
      }, 900);
    },
    [expandedPaths, loadDirectory]
  );

  useEffect(() => {
    if (!user) {
      setRootLoaded(false);
      return;
    }
    let cancelled = false;
    setRootLoaded(false);
    setSearchIndexLoaded(false);
    setSearchIndexAttempted(false);
    void loadDirectory(ROOT_PATH).finally(() => {
      if (!cancelled) {
        setRootLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user, loadDirectory]);

  useEffect(() => {
    if (!user) return;
    if (!searchTerm.trim()) return;
    if (searchIndexLoaded || searchLoading || searchIndexAttempted) return;
    setSearchLoading(true);
    void loadDirectory(ROOT_PATH, {
      recursive: true,
      includeHidden: false,
      timeoutMs: 10000,
    }).finally(() => {
      setSearchLoading(false);
      setSearchIndexLoaded(true);
      setSearchIndexAttempted(true);
    });
  }, [loadDirectory, searchIndexAttempted, searchIndexLoaded, searchLoading, searchTerm, user]);


  const updateTab = useCallback((path: string, updater: (tab: OpenTab) => OpenTab) => {
    setOpenTabs((prev) => {
      const index = prev.findIndex((tab) => tab.path === path);
      if (index === -1) {
        const base: OpenTab = { path, title: getBasename(path), isDirty: false };
        return [...prev, updater(base)];
      }
      return prev.map((tab) => (tab.path === path ? updater(tab) : tab));
    });
  }, []);

  const disposeModel = useCallback((path: string) => {
    const model = modelsRef.current.get(path);
    if (model) {
      if (!editorDisposedRef.current && editorRef.current?.getModel() === model) {
        editorRef.current?.setModel(null);
      }
      if (!model.isDisposed()) {
        model.dispose();
      }
      modelsRef.current.delete(path);
    }
    const disposable = modelDisposablesRef.current.get(path);
    if (disposable) {
      disposable.dispose();
      modelDisposablesRef.current.delete(path);
    }
    savedHashesRef.current.delete(path);
    versionsRef.current.delete(path);
  }, []);

  const syncDirtyState = useCallback(
    (path: string) => {
      const model = modelsRef.current.get(path);
      if (!model || model.isDisposed()) return;
      const currentHash = hashString(model.getValue());
      const savedHash = savedHashesRef.current.get(path);
      const isDirty = savedHash ? savedHash !== currentHash : currentHash.length > 0;
      updateTab(path, (tab) => ({ ...tab, isDirty }));
    },
    [updateTab]
  );

  const ensureModel = useCallback(
    (path: string, content: string, language: string) => {
      const monaco = monacoRef.current;
      if (!monaco) {
        pendingModelsRef.current.set(path, { content, language });
        return;
      }

      const uri = monaco.Uri.parse(`file://${path}`);
      let model = monaco.editor.getModel(uri);
      if (model?.isDisposed()) {
        disposeModel(path);
        model = null;
      }
      if (!model) {
        model = monaco.editor.createModel(content, language, uri);
      } else if (model.getValue() !== content) {
        model.setValue(content);
      }

      modelsRef.current.set(path, model);

      if (!modelDisposablesRef.current.has(path)) {
        const disposable = model.onDidChangeContent(() => syncDirtyState(path));
        modelDisposablesRef.current.set(path, disposable);
      }

      if (editorRef.current && activePathRef.current === path) {
        if (!editorDisposedRef.current) {
          editorRef.current.setModel(model);
          editorRef.current.focus();
        }
      }
    },
    [disposeModel, syncDirtyState]
  );

  const openFile = useCallback(
    async (path: string, options: { focus?: boolean; force?: boolean } = {}) => {
      const normalizedPath = normalizePath(path);
      const node = nodesByPath[normalizedPath];
      if (node?.kind === 'dir') return;

      setOpenTabs((prev) => {
        if (prev.some((tab) => tab.path === normalizedPath)) {
          return prev;
        }
        return [
          ...prev,
          {
            path: normalizedPath,
            title: getBasename(normalizedPath),
            isDirty: false,
          },
        ];
      });

      if (options.focus !== false) {
        setActivePath(normalizedPath);
      }

      const size = node?.size ?? null;
      if (size && size > MAX_EDITABLE_BYTES && !options.force) {
        updateTab(normalizedPath, (tab) => ({
          ...tab,
          isTooLarge: true,
        }));
        return;
      }
      if (options.force) {
        updateTab(normalizedPath, (tab) => ({
          ...tab,
          isTooLarge: false,
        }));
      }

      if (modelsRef.current.has(normalizedPath)) {
        const existingModel = modelsRef.current.get(normalizedPath);
        if (!existingModel || !existingModel.isDisposed()) {
          return;
        }
        disposeModel(normalizedPath);
      }

      if (openingFilesRef.current.has(normalizedPath)) {
        return;
      }
      openingFilesRef.current.add(normalizedPath);

      try {
        const res = await fetch(
          `${apiBase}/read?path=${encodeURIComponent(normalizedPath)}`
        );
        const payload = (await res
          .json()
          .catch(() => null)) as WorkspaceFileReadPayload | null;

        if (!res.ok) {
          if (res.status === 404 || isReadNotFoundError(payload)) {
            updateTab(normalizedPath, (tab) => ({
              ...tab,
              notFound: true,
            }));
            return;
          }
          throw new Error(payload?.error || 'Failed to open file');
        }

        if (!payload) {
          throw new Error('Invalid file read response');
        }

        if (payload?.success === false) {
          if (isReadNotFoundError(payload)) {
            updateTab(normalizedPath, (tab) => ({
              ...tab,
              notFound: true,
            }));
            return;
          }
          throw new Error(payload.error || 'Failed to open file');
        }

        const data = toWorkspaceFileRead(payload, normalizedPath);
        const effectiveSize = typeof data.size === 'number' ? data.size : null;
        if (effectiveSize && effectiveSize > MAX_EDITABLE_BYTES && !options.force) {
          updateTab(normalizedPath, (tab) => ({
            ...tab,
            isBinary: data.isBinary,
            isTooLarge: true,
            version: data.version,
            isDirty: false,
            notFound: false,
          }));
          return;
        }

        updateTab(normalizedPath, (tab) => ({
          ...tab,
          isBinary: data.isBinary,
          isTooLarge: false,
          version: data.version,
          isDirty: false,
          notFound: false,
        }));

        if (data.isBinary) {
          return;
        }

        const language = getLanguageForPath(normalizedPath);
        ensureModel(normalizedPath, data.content, language);
        savedHashesRef.current.set(normalizedPath, hashString(data.content));
        versionsRef.current.set(normalizedPath, data.version);
      } catch (error) {
        console.error('Failed to open file', error);
      } finally {
        openingFilesRef.current.delete(normalizedPath);
      }
    },
    [apiBase, ensureModel, nodesByPath, updateTab]
  );

  useEffect(() => {
    if (!hydrated || restoredTabsRef.current) return;
    if (openTabs.length > 0) {
      openTabs.forEach((tab) => {
        void openFile(tab.path, { focus: tab.path === activePath });
      });
    }
    restoredTabsRef.current = true;
  }, [activePath, hydrated, openFile, openTabs]);

  const saveFile = useCallback(
    async (path: string, force?: boolean) => {
      if (!canMutate) return;
      const model = modelsRef.current.get(path);
      if (!model || model.isDisposed()) return;

      const content = model.getValue();
      const baseVersion = force ? undefined : versionsRef.current.get(path) ?? null;

      setSavingPaths((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });

      try {
        const res = await fetch(`${apiBase}/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content, baseVersion }),
        });

        if (res.status === 409) {
          const latest = await fetch(
            `${apiBase}/read?path=${encodeURIComponent(path)}`
          );
          if (latest.ok) {
            const payload = (await latest
              .json()
              .catch(() => null)) as WorkspaceFileReadPayload | null;
            if (!payload) {
              return;
            }
            if (payload?.success === false) {
              return;
            }
            const latestFile = toWorkspaceFileRead(payload, path);
            setConflictState({
              path,
              localContent: content,
              remoteContent: latestFile.content,
              remoteVersion: latestFile.version,
            });
          }
          return;
        }

        if (!res.ok) {
          const payload = (await res
            .json()
            .catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || 'Failed to save file');
        }

        const payload = (await res.json()) as { newVersion: string };
        savedHashesRef.current.set(path, hashString(content));
        versionsRef.current.set(path, payload.newVersion);
        updateTab(path, (tab) => ({ ...tab, isDirty: false }));
      } catch (error) {
        console.error('Failed to save file', error);
      } finally {
        setSavingPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [apiBase, canMutate, updateTab]
  );

  const downloadFile = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(
          `${apiBase}/read?path=${encodeURIComponent(path)}`
        );
        if (!res.ok) return;
        const payload = (await res
          .json()
          .catch(() => null)) as WorkspaceFileReadPayload | null;
        if (!payload) return;
        if (payload?.success === false) return;
        const data = toWorkspaceFileRead(payload, path);
        let blob: Blob;
        if (data.isBinary && data.encoding === 'base64') {
          const raw = atob(data.content);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i += 1) {
            bytes[i] = raw.charCodeAt(i);
          }
          blob = new Blob([bytes], {
            type: data.mimeType ?? 'application/octet-stream',
          });
        } else {
          blob = new Blob([data.content], {
            type: data.mimeType ?? 'text/plain',
          });
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = getBasename(path);
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      } catch (error) {
        console.error('Failed to download file', error);
      }
    },
    [apiBase]
  );

  const uploadFiles = useCallback(
    async (files: FileList | File[], targetPath: string = ROOT_PATH) => {
      if (!canMutate) return;

      for (const file of Array.from(files)) {
        // Check file size before uploading
        if (file.size > MAX_UPLOAD_SIZE) {
          const sizeMB = Math.round(file.size / 1024 / 1024);
          console.error(`File "${file.name}" is too large (${sizeMB}MB). Maximum size is 50MB.`);
          continue;
        }

        const uploadId = `${targetPath}/${file.name}`;
        setUploadingFiles((prev) => new Set(prev).add(uploadId));

        try {
          const formData = new FormData();
          formData.append('file', file);
          formData.append('path', targetPath);

          const res = await fetch(`${apiBase}/upload`, {
            method: 'POST',
            body: formData,
          });

          if (!res.ok) {
            const payload = (await res.json().catch(() => null)) as { error?: string } | null;
            console.error('Failed to upload file:', payload?.error || 'Unknown error');
            continue;
          }

          const data = (await res.json()) as { path: string; filename: string };

          // Refresh the target directory to show the new file
          await loadDirectory(targetPath);

          // Optionally open the uploaded file
          if (!data.path.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|tar|gz|mp3|mp4|wav|avi|mov)$/i)) {
            openFile(data.path, { force: false });
          }
        } catch (error) {
          console.error('Failed to upload file:', error);
        } finally {
          setUploadingFiles((prev) => {
            const next = new Set(prev);
            next.delete(uploadId);
            return next;
          });
        }
      }
    },
    [apiBase, canMutate, loadDirectory, openFile]
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0) {
        void uploadFiles(files, uploadTargetPath);
      }
      // Reset input so the same file can be selected again
      event.target.value = '';
    },
    [uploadFiles, uploadTargetPath]
  );

  const triggerUpload = useCallback((targetPath: string = ROOT_PATH) => {
    if (!canMutate) return;
    setUploadTargetPath(targetPath);
    fileInputRef.current?.click();
  }, [canMutate]);

  useEffect(() => {
    saveFileRef.current = saveFile;
  }, [saveFile]);

  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const index = prev.findIndex((tab) => tab.path === path);
        if (index === -1) return prev;
        const nextTabs = prev.filter((tab) => tab.path !== path);
        if (activePath === path) {
          const nextActive = nextTabs[index] ?? nextTabs[index - 1] ?? null;
          setActivePath(nextActive?.path ?? null);
        }
        return nextTabs;
      });
      disposeModel(path);
    },
    [activePath, disposeModel]
  );

  const removeTabsUnderPath = useCallback(
    (path: string) => {
      const prefix = `${path}/`;
      setOpenTabs((prev) => {
        const remaining: OpenTab[] = [];
        const removed: OpenTab[] = [];
        prev.forEach((tab) => {
          const shouldRemove = tab.path === path || tab.path.startsWith(prefix);
          if (shouldRemove) {
            removed.push(tab);
          } else {
            remaining.push(tab);
          }
        });
        removed.forEach((tab) => disposeModel(tab.path));
        if (activePath && (activePath === path || activePath.startsWith(prefix))) {
          setActivePath(remaining[0]?.path ?? null);
        }
        return remaining;
      });
    },
    [activePath, disposeModel]
  );

  const toggleDirectory = useCallback(
    async (path: string) => {
      const node = nodesByPath[path];
      if (!node || node.kind !== 'dir') return;

      if (expandedPaths.has(path)) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        return;
      }

      if (!node.isLoaded) {
        await loadDirectory(path);
      }
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
    },
    [expandedPaths, loadDirectory, nodesByPath]
  );

  const ensurePathExpanded = useCallback(
    async (path: string) => {
      const segments = normalizePath(path).split('/').filter(Boolean);
      let current = ROOT_PATH;
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const nextPath = joinPath(current, segment);
        const isLast = index === segments.length - 1;
        const node = nodesByPath[nextPath];
        if (!isLast && (!node || (node.kind === 'dir' && !node.isLoaded))) {
          await loadDirectory(nextPath);
        }
        if (!isLast || node?.kind === 'dir') {
          setExpandedPaths((prev) => {
            const next = new Set(prev);
            next.add(nextPath);
            return next;
          });
        }
        current = nextPath;
      }
    },
    [loadDirectory, nodesByPath]
  );

  const scrollToNode = useCallback((path: string) => {
    const container = treeContainerRef.current;
    if (!container) return;
    const selector = `[data-path="${CSS.escape(path)}"]`;
    const row = container.querySelector(selector) as HTMLElement | null;
    if (row) {
      row.scrollIntoView({ block: 'center' });
    }
  }, []);

  const handleBreadcrumbClick = useCallback(
    async (path: string) => {
      await ensurePathExpanded(path);
      scrollToNode(path);
      const node = nodesByPath[path];
      if (node?.kind === 'file') {
        openFile(path);
      }
    },
    [ensurePathExpanded, nodesByPath, openFile, scrollToNode]
  );

  useEffect(() => {
    if (!hydrated || !rootLoaded) return;
    const initialFileParam = searchParams?.get('file');
    if (!initialFileParam) return;
    if (initialFileHandledRef.current === initialFileParam) return;

    initialFileHandledRef.current = initialFileParam;
    let decodedPath = initialFileParam;
    try {
      decodedPath = decodeURIComponent(initialFileParam);
    } catch {
      decodedPath = initialFileParam;
    }
    const normalizedPath = coerceWorkspacePath(decodedPath);
    void ensurePathExpanded(normalizedPath).then(() => {
      openFile(normalizedPath);
      scrollToNode(normalizedPath);
    });
  }, [ensurePathExpanded, hydrated, openFile, rootLoaded, scrollToNode, searchParams]);

  const remapOpenResources = useCallback(
    (fromPath: string, toPath: string) => {
      const fromPrefix = `${fromPath}/`;
      setExpandedPaths((prev) => {
        const next = new Set<string>();
        prev.forEach((path) => {
          const shouldRemap = path === fromPath || path.startsWith(fromPrefix);
          if (shouldRemap) {
            next.add(toPath + path.slice(fromPath.length));
          } else {
            next.add(path);
          }
        });
        next.add(ROOT_PATH);
        return next;
      });
      setOpenTabs((prev) =>
        prev.map((tab) => {
          const shouldRemap =
            tab.path === fromPath || tab.path.startsWith(fromPrefix);
          if (!shouldRemap) return tab;
          const nextPath = toPath + tab.path.slice(fromPath.length);
          return {
            ...tab,
            path: nextPath,
            title: getBasename(nextPath),
          };
        })
      );

      setActivePath((prev) => {
        if (!prev) return prev;
        if (prev === fromPath || prev.startsWith(fromPrefix)) {
          return toPath + prev.slice(fromPath.length);
        }
        return prev;
      });

      const entries = Array.from(modelsRef.current.entries());
      entries.forEach(([oldPath, model]) => {
        const shouldRemap =
          oldPath === fromPath || oldPath.startsWith(fromPrefix);
        if (!shouldRemap) return;
        if (model.isDisposed()) {
          disposeModel(oldPath);
          return;
        }
        const nextPath = toPath + oldPath.slice(fromPath.length);
        const content = model.getValue();
        const language = model.getLanguageId();
        const savedHash = savedHashesRef.current.get(oldPath);
        const version = versionsRef.current.get(oldPath);
        disposeModel(oldPath);
        ensureModel(nextPath, content, language);
        if (savedHash) {
          savedHashesRef.current.set(nextPath, savedHash);
        }
        if (version) {
          versionsRef.current.set(nextPath, version);
        }
      });
    },
    [disposeModel, ensureModel]
  );

  const handleDrop = useCallback(
    async (targetPath: string, sourcePath: string) => {
      if (!canMutate) {
        clearDragState();
        return;
      }
      const normalizedTarget = normalizePath(targetPath);
      const normalizedSource = normalizePath(sourcePath);
      if (normalizedTarget === normalizedSource) {
        clearDragState();
        return;
      }
      if (normalizedTarget.startsWith(`${normalizedSource}/`)) {
        clearDragState();
        return;
      }

      const destination = joinPath(normalizedTarget, getBasename(normalizedSource));
      try {
        const res = await fetch(`${apiBase}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: normalizedSource, to: destination }),
        });
        if (!res.ok) {
          return;
        }

        remapOpenResources(normalizedSource, destination);

        await loadDirectory(getParentPath(normalizedSource));
        await loadDirectory(normalizedTarget);
      } catch (error) {
        console.error('Move failed', error);
      } finally {
        clearDragState();
      }
    },
    [apiBase, canMutate, clearDragState, loadDirectory, remapOpenResources]
  );

  const closeDialog = useCallback(() => {
    setDialogState(null);
    setDialogName('');
    setDialogSubmitting(false);
    setDialogError(null);
  }, []);

  const openDialog = useCallback((state: DialogState) => {
    if (!canMutate) return;
    setDialogSubmitting(false);
    setDialogError(null);
    setDialogState(state);
    if (state?.type === 'rename') {
      setDialogName(getBasename(state.path));
      return;
    }
    setDialogName('');
  }, [canMutate]);

  const handleConfirmDialog = useCallback(async () => {
    if (!canMutate || !dialogState || dialogSubmitting) return;
    const requiresName =
      dialogState.type === 'new-file' ||
      dialogState.type === 'new-folder' ||
      dialogState.type === 'rename';
    if (requiresName && !dialogName.trim()) return;

    setDialogError(null);

    if (dialogState.type === 'new-file' || dialogState.type === 'new-folder') {
      const name = dialogName.trim();
      const parentPath = dialogState.parentPath;
      const targetPath = joinPath(parentPath, name);
      if (nodesByPath[targetPath]) {
        setDialogError(`"${getBasename(targetPath)}" already exists in this folder.`);
        return;
      }
    }

    if (dialogState.type === 'rename') {
      const name = dialogName.trim();
      const fromPath = dialogState.path;
      const toPath = joinPath(getParentPath(fromPath), name);
      if (fromPath !== toPath && nodesByPath[toPath]) {
        setDialogError(`"${getBasename(toPath)}" already exists in this folder.`);
        return;
      }
    }

    setDialogSubmitting(true);

    try {
      if (dialogState.type === 'new-file' || dialogState.type === 'new-folder') {
        const name = dialogName.trim();
        const parentPath = dialogState.parentPath;
        const targetPath = joinPath(parentPath, name);
        const endpoint = dialogState.type === 'new-file' ? 'create' : 'mkdir';
        const body =
          dialogState.type === 'new-file'
            ? { path: targetPath, content: '' }
            : { path: targetPath };

        const res = await fetch(`${apiBase}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 409) {
          const payload = (await res
            .json()
            .catch(() => null)) as { error?: string } | null;
          setDialogError(payload?.error || 'An item with this name already exists.');
          return;
        }
        if (res.ok) {
          closeDialog();
          await loadDirectory(parentPath);
          if (dialogState.type === 'new-file') {
            openFile(targetPath);
          }
        }
        return;
      }

      if (dialogState.type === 'rename') {
        const name = dialogName.trim();
        const fromPath = dialogState.path;
        const toPath = joinPath(getParentPath(fromPath), name);
        if (fromPath !== toPath) {
          const res = await fetch(`${apiBase}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: fromPath, to: toPath }),
          });
          if (res.status === 409) {
            const payload = (await res
              .json()
              .catch(() => null)) as { error?: string } | null;
            setDialogError(payload?.error || 'An item with this name already exists.');
            return;
          }
          if (res.ok) {
            closeDialog();
            remapOpenResources(fromPath, toPath);
            await loadDirectory(getParentPath(fromPath));
          }
          return;
        }
        closeDialog();
        return;
      }

      if (dialogState.type === 'delete') {
        const targetPath = dialogState.path;
        const res = await fetch(`${apiBase}/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: targetPath }),
        });
        if (res.ok) {
          closeDialog();
          removeTabsUnderPath(targetPath);
          setExpandedPaths((prev) => {
            const next = new Set(
              Array.from(prev).filter(
                (path) => !(path === targetPath || path.startsWith(`${targetPath}/`))
              )
            );
            next.add(ROOT_PATH);
            return next;
          });
          await loadDirectory(getParentPath(targetPath));
        }
      }
    } catch (error) {
      console.error('Failed to apply dialog action', error);
    } finally {
      setDialogSubmitting(false);
    }
  }, [
    apiBase,
    canMutate,
    dialogName,
    dialogState,
    dialogSubmitting,
    closeDialog,
    loadDirectory,
    nodesByPath,
    openFile,
    remapOpenResources,
    removeTabsUnderPath,
  ]);

  const editorOptions = useMemo<monacoEditor.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      readOnly: !canMutate,
      readOnlyMessage: { value: '' },
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
      parameterHints: { enabled: false },
      hover: { enabled: false },
      codeLens: false,
      inlayHints: { enabled: 'off' },
      contextmenu: false,
    }),
    [canMutate]
  );

  const activeTab = useMemo(
    () => openTabs.find((tab) => tab.path === activePath) ?? null,
    [activePath, openTabs]
  );

  useEffect(() => {
    if (!activeTab || !editorRef.current || editorDisposedRef.current) return;
    if (activeTab.isTooLarge || activeTab.isBinary || activeTab.notFound) return;
    const model = modelsRef.current.get(activeTab.path);
    if (!model) {
      void openFile(activeTab.path, { focus: false });
      return;
    }
    if (model) {
      if (model.isDisposed()) {
        disposeModel(activeTab.path);
        void openFile(activeTab.path, { focus: false });
        return;
      }
      if (editorRef.current.getModel() !== model) {
        editorRef.current.setModel(model);
      }
      editorRef.current.focus();
    }
  }, [activeTab, disposeModel, openFile]);

  const breadcrumbItems = useMemo(() => {
    if (!activePath) return [] as { label: string; path: string }[];
    const parts = normalizePath(activePath).split('/').filter(Boolean);
    const items: { label: string; path: string }[] = [];
    let current = ROOT_PATH;
    parts.forEach((part) => {
      current = joinPath(current, part);
      items.push({ label: part, path: current });
    });
    return items;
  }, [activePath]);

  const treeRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const matches = new Set<string>();
    if (term) {
      Object.values(nodesByPath).forEach((node) => {
        const label = `${node.name} ${node.path}`.toLowerCase();
        if (label.includes(term)) {
          let current = node.path;
          while (current && current !== ROOT_PATH) {
            matches.add(current);
            current = getParentPath(current);
          }
          matches.add(ROOT_PATH);
        }
      });
    }

    const rows: TreeRow[] = [];
    const traverse = (path: string, depth: number) => {
      const node = nodesByPath[path];
      if (!node) return;
      if (path !== ROOT_PATH) {
        if (term && !matches.has(path)) return;
        rows.push({
          node,
          depth,
          isMatch: term ? node.name.toLowerCase().includes(term) : false,
        });
      }

      const shouldExpand = term ? matches.has(path) : expandedPaths.has(path);
      if (node.kind === 'dir' && shouldExpand) {
        const children = [...node.children].sort((a, b) => {
          const nodeA = nodesByPath[a];
          const nodeB = nodesByPath[b];
          if (nodeA?.kind !== nodeB?.kind) {
            return nodeA?.kind === 'dir' ? -1 : 1;
          }
          return (nodeA?.name ?? a).localeCompare(nodeB?.name ?? b);
        });
        children.forEach((child) => traverse(child, depth + 1));
      }
    };

    traverse(ROOT_PATH, 0);
    return rows;
  }, [expandedPaths, nodesByPath, searchTerm]);

  useEffect(() => {
    if (!monacoReady || pendingModelsRef.current.size === 0) return;
    pendingModelsRef.current.forEach((value, path) => {
      ensureModel(path, value.content, value.language);
      savedHashesRef.current.set(path, hashString(value.content));
    });
    pendingModelsRef.current.clear();
  }, [ensureModel, monacoReady]);

  const isSavingActive = activePath ? savingPaths.has(activePath) : false;
  const isTreeLoading = loadingPaths.has(ROOT_PATH);
  const hasSearchTerm = searchTerm.trim().length > 0;
  const showSearchLoading = hasSearchTerm && searchLoading && treeRows.length === 0;
  const dragSource = dragSourcePathRef.current;
  const dragEnabled = canMutate;
  const canDropToRoot =
    dragEnabled && isDragging && dragSource !== null && canDropInto(ROOT_PATH, dragSource);
  const isRootDragOver = dragOverPath === ROOT_PATH;

  return (
    <div className="flex h-full w-full flex-1 min-h-0 min-w-0 overflow-hidden">
      <ResizablePanelGroup
        direction="horizontal"
        className="h-full w-full flex-1 min-h-0 min-w-0"
      >
        <ResizablePanel
          defaultSize="22%"
          minSize="16%"
          maxSize="40%"
          className="flex min-h-0 min-w-0 flex-col"
        >
          <div className="flex h-full min-h-0 min-w-0 flex-col border-r bg-muted/20">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="flex min-w-[240px] flex-1 items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Files
                </span>
                <InputGroup className="min-w-[160px] flex-1">
                  <InputGroupAddon>
                    <Search className="size-3.5" />
                  </InputGroupAddon>
                  <InputGroupInput
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Filter files"
                  />
                </InputGroup>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={!canMutate}
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">New file or folder</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={!canMutate}
                      onSelect={() => openDialog({ type: 'new-file', parentPath: ROOT_PATH })}
                    >
                      New file
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canMutate}
                      onSelect={() => openDialog({ type: 'new-folder', parentPath: ROOT_PATH })}
                    >
                      New folder
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canMutate}
                      onSelect={() => {
                        if (!canMutate) return;
                        triggerUpload(ROOT_PATH);
                      }}
                    >
                      Upload file
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        setSearchIndexLoaded(false);
                        setSearchIndexAttempted(false);
                        void loadDirectory(ROOT_PATH);
                      }}
                    >
                      <RefreshCw
                        className={cn('size-3.5', isTreeLoading && 'animate-spin')}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Refresh files</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <Separator />
            <div className="flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div
                  ref={treeContainerRef}
                  className="py-2"
                  onDragLeave={(event) => {
                    const related = event.relatedTarget as Node | null;
                    if (
                      related &&
                      (event.currentTarget as HTMLElement).contains(related)
                    ) {
                      return;
                    }
                    clearDragState();
                  }}
                  onDrop={clearDragState}
                >
                  {canDropToRoot && (
                    <div className="sticky top-0 z-10 px-2 pb-2">
                      <div
                        className={cn(
                          'relative flex items-center gap-2 rounded-md border border-dashed px-2 py-1 text-xs transition',
                          isRootDragOver
                            ? 'border-primary/60 bg-primary/10 text-foreground'
                            : 'border-muted-foreground/30 bg-muted/30 text-muted-foreground'
                        )}
                        onDragOver={(event) => {
                          event.preventDefault();
                          if (!dragSourcePathRef.current) return;
                          const canDrop = canDropInto(
                            ROOT_PATH,
                            dragSourcePathRef.current
                          );
                          event.dataTransfer.dropEffect = canDrop ? 'move' : 'none';
                          if (!canDrop) return;
                          if (dragOverPathRef.current !== ROOT_PATH) {
                            setDragOverPath(ROOT_PATH);
                            dragOverPathRef.current = ROOT_PATH;
                          }
                        }}
                        onDragLeave={(event) => {
                          if (dragOverPathRef.current !== ROOT_PATH) return;
                          const related = event.relatedTarget as Node | null;
                          if (
                            related &&
                            (event.currentTarget as HTMLElement).contains(related)
                          ) {
                            return;
                          }
                          setDragOverPath(null);
                          dragOverPathRef.current = null;
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const sourcePath = event.dataTransfer.getData('text/plain');
                          if (sourcePath) {
                            void handleDrop(ROOT_PATH, sourcePath);
                          } else {
                            clearDragState();
                          }
                        }}
                      >
                        <span className="font-semibold uppercase tracking-wide">
                          Workspace
                        </span>
                        <span>Drop to move to root</span>
                        {isRootDragOver && (
                          <span className="pointer-events-none absolute inset-x-2 bottom-0 h-px bg-primary/60" />
                        )}
                      </div>
                    </div>
                  )}
                  {treeError && (
                    <div className="px-3 py-2 text-xs text-destructive">
                      {treeError}
                    </div>
                  )}
                  {showSearchLoading && (
                    <div className="px-3 py-3 space-y-2">
                      {Array.from({ length: 6 }).map((_, index) => (
                        <div key={`search-skeleton-${index}`} className="flex items-center gap-2">
                          <Skeleton className="h-3 w-3 rounded-sm" />
                          <Skeleton className="h-3 w-3 rounded-sm" />
                          <Skeleton className="h-3 flex-1" />
                        </div>
                      ))}
                    </div>
                  )}
                  {treeRows.length === 0 && !treeError && !showSearchLoading && (
                    <div className="px-3 py-6 text-xs text-muted-foreground">
                      {hasSearchTerm
                        ? 'No matches found.'
                        : isTreeLoading
                          ? 'Loading workspace...'
                          : 'No files found yet.'}
                    </div>
                  )}
                  {treeRows.map(({ node, depth, isMatch }) => {
                      const isExpanded = expandedPaths.has(node.path);
                      const isActive = activePath === node.path;
                      const isDirectory = node.kind === 'dir';
                      const isDropAllowed =
                        dragEnabled &&
                        isDragging &&
                        dragSource !== null &&
                        isDirectory &&
                        canDropInto(node.path, dragSource);
                      const isDragOver = dragOverPath === node.path && isDropAllowed;
                      const Icon =
                        isDirectory ? (isExpanded ? FolderOpen : Folder) : getFileIcon(node.path);
                      const isLoading = loadingPaths.has(node.path);
                      return (
                        <ContextMenu key={node.path}>
                          <ContextMenuTrigger asChild>
                            <div
                              data-path={node.path}
                              draggable={node.path !== ROOT_PATH}
                              onDragStart={(event) => {
                                if (!dragEnabled) {
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = 'none';
                                  triggerDragBlocked(node.path);
                                  return;
                                }
                                event.dataTransfer.setData('text/plain', node.path);
                                event.dataTransfer.effectAllowed = 'move';
                                dragSourcePathRef.current = node.path;
                                dragOverPathRef.current = null;
                                if (!isDragging) {
                                  requestAnimationFrame(() => {
                                    setIsDragging(true);
                                  });
                                }
                              }}
                              onDragEnd={clearDragState}
                              onDragOver={(event) => {
                                if (!dragEnabled) {
                                  event.dataTransfer.dropEffect = 'none';
                                  return;
                                }
                                if (!isDirectory) {
                                  event.dataTransfer.dropEffect = 'none';
                                  return;
                                }
                                event.preventDefault();
                                if (!dragSourcePathRef.current) {
                                  event.dataTransfer.dropEffect = 'none';
                                  return;
                                }
                                const canDrop = canDropInto(
                                  node.path,
                                  dragSourcePathRef.current
                                );
                                event.dataTransfer.dropEffect = canDrop ? 'move' : 'none';
                                if (!canDrop) return;
                                if (dragOverPathRef.current !== node.path) {
                                  setDragOverPath(node.path);
                                  dragOverPathRef.current = node.path;
                                }
                                scheduleAutoExpand(node.path);
                              }}
                              onDragLeave={(event) => {
                                if (dragOverPathRef.current !== node.path) return;
                                const related = event.relatedTarget as Node | null;
                                if (
                                  related &&
                                  (event.currentTarget as HTMLElement).contains(related)
                                ) {
                                  return;
                                }
                                setDragOverPath(null);
                                dragOverPathRef.current = null;
                              }}
                              onDrop={(event) => {
                                if (!dragEnabled) {
                                  clearDragState();
                                  return;
                                }
                                if (!isDirectory) return;
                                event.preventDefault();
                                const sourcePath = event.dataTransfer.getData('text/plain');
                                if (sourcePath) {
                                  void handleDrop(node.path, sourcePath);
                                } else {
                                  clearDragState();
                                }
                              }}
                              className={cn(
                                'group relative flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                                isActive && 'bg-muted text-foreground',
                                isMatch && 'text-foreground',
                                isDragOver &&
                                  'bg-primary/10 text-foreground ring-1 ring-primary/30'
                              )}
                              style={{ paddingLeft: `${depth * 12 + 8}px` }}
                              onClick={() =>
                                isDirectory ? toggleDirectory(node.path) : openFile(node.path)
                              }
                            >
                              {!dragEnabled && dragBlockedPath === node.path && (
                                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-border bg-background/90 px-2 py-0.5 text-[10px] font-medium text-foreground">
                                  {readOnly
                                    ? 'Admin read-only mode'
                                    : BETA_FILE_EDIT_DISABLED_MESSAGE}
                                </span>
                              )}
                              {isDragOver && (
                                <span className="pointer-events-none absolute inset-x-2 bottom-0 h-px bg-primary/60" />
                              )}
                              {isDirectory ? (
                                <span className="mr-1 flex size-4 items-center justify-center">
                                  {isExpanded ? (
                                    <ChevronDown className="size-3.5" />
                                  ) : (
                                    <ChevronRight className="size-3.5" />
                                  )}
                                </span>
                              ) : (
                                <span className="mr-1 flex size-4 items-center justify-center" />
                              )}
                              <Icon className="size-3.5" />
                              <span className="min-w-0 flex-1 truncate">
                                {node.name}
                              </span>
                              {isLoading && (
                                <RefreshCw className="size-3 animate-spin" />
                              )}
                            </div>
                          </ContextMenuTrigger>
                        <ContextMenuContent>
                          {isDirectory && (
                            <>
                              <ContextMenuItem
                                disabled={!canMutate}
                                onSelect={() =>
                                  openDialog({ type: 'new-file', parentPath: node.path })
                                }
                              >
                                New file
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={!canMutate}
                                onSelect={() =>
                                  openDialog({ type: 'new-folder', parentPath: node.path })
                                }
                              >
                                New folder
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={!canMutate}
                                onSelect={() => {
                                  if (!canMutate) return;
                                  triggerUpload(node.path);
                                }}
                              >
                                Upload file
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                            </>
                          )}
                          <ContextMenuItem disabled>
                            {readOnly
                              ? 'Admin read-only mode'
                              : BETA_FILE_EDIT_DISABLED_MESSAGE}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          {node.path !== ROOT_PATH && (
                            <>
                              <ContextMenuItem
                                disabled={!canMutate}
                                onSelect={() => {
                                  if (!canMutate) return;
                                  openDialog({ type: 'rename', path: node.path });
                                }}
                              >
                                Rename
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={!canMutate}
                                onSelect={() => {
                                  if (!canMutate) return;
                                  openDialog({
                                    type: 'delete',
                                    path: node.path,
                                    kind: node.kind,
                                  });
                                }}
                                variant="destructive"
                              >
                                Delete
                              </ContextMenuItem>
                            </>
                          )}
                          {!isDirectory && (
                            <>
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                onSelect={() => void downloadFile(node.path)}
                              >
                                Download
                              </ContextMenuItem>
                            </>
                          )}
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onSelect={() => void copyToClipboard(node.path)}
                          >
                            Copy path
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => void copyToClipboard(getRelativePath(node.path))}
                          >
                            Copy relative path
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          defaultSize="78%"
          className="flex min-h-0 min-w-0 flex-col"
        >
          <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <button
                        type="button"
                        className="text-xs"
                        onClick={() => handleBreadcrumbClick(ROOT_PATH)}
                      >
                        workspace
                      </button>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  {breadcrumbItems.map((item) => (
                    <Fragment key={item.path}>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        <BreadcrumbLink asChild>
                          <button
                            type="button"
                            className="text-xs"
                            onClick={() => handleBreadcrumbClick(item.path)}
                          >
                            {item.label}
                          </button>
                        </BreadcrumbLink>
                      </BreadcrumbItem>
                    </Fragment>
                  ))}
                </BreadcrumbList>
              </Breadcrumb>
              <div className="flex flex-wrap items-center gap-3">
                {!canMutate && (
                  <Badge variant="secondary" className="text-[11px]">
                    Read-only
                  </Badge>
                )}
                {isSavingActive && (
                  <Badge variant="outline" className="text-[11px]">
                    Saving...
                  </Badge>
                )}
                {readOnly && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Admin read-only mode</span>
                  </div>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => {
                    if (activePath) {
                      void saveFile(activePath);
                    }
                  }}
                  disabled={!activePath || !canMutate}
                >
                  <Save className="mr-2 size-4" />
                  Save
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1">
              <div className="flex flex-1 items-center gap-1 overflow-x-auto">
                {openTabs.length === 0 && (
                  <span className="px-2 text-xs text-muted-foreground">
                    Open a file to inspect it.
                  </span>
                )}
                {openTabs.map((tab) => (
                  <button
                    key={tab.path}
                    type="button"
                    onClick={() => setActivePath(tab.path)}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                      tab.path === activePath && 'bg-background text-foreground'
                    )}
                  >
                    <span className="truncate max-w-[140px]">{tab.title}</span>
                    {tab.isDirty ? (
                      <span className="size-1.5 rounded-full bg-amber-400" />
                    ) : null}
                    <span
                      role="button"
                      tabIndex={0}
                      className="rounded p-0.5 hover:bg-muted"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.path);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          closeTab(tab.path);
                        }
                      }}
                    >
                      <X className="size-3" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-h-0">
              {!activeTab && (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Select a file from the explorer to preview it here.
                </div>
              )}
              {activeTab?.isTooLarge && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <AlertTriangle className="size-5" />
                  <div>
                    File is too large to edit here.
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void downloadFile(activeTab.path)}
                    >
                      Download file
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => openFile(activeTab.path, { force: true })}
                    >
                      Try opening anyway
                    </Button>
                  </div>
                </div>
              )}
              {activeTab?.isBinary && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <AlertTriangle className="size-5" />
                  <div>
                    Binary file preview is not supported.
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => void downloadFile(activeTab.path)}
                  >
                    Download file
                  </Button>
                </div>
              )}
              {activeTab?.notFound && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <FileQuestion className="size-5" />
                  <div>File not found.</div>
                  <div className="text-xs text-muted-foreground/60">
                    This file may have been moved, renamed, or deleted.
                  </div>
                </div>
              )}
              {activeTab && !activeTab.isTooLarge && !activeTab.isBinary && !activeTab.notFound && (
                <div className="relative h-full">
                  {readOnlyHintOpen && !canMutate && (
                    <div className="pointer-events-none absolute right-4 top-4 z-10">
                      <Alert className="w-[240px] border-border/60 bg-background/95 shadow-lg">
                        <AlertTitle>Read-only</AlertTitle>
                        <AlertDescription>
                          {readOnly
                            ? 'Admin read-only mode is enabled for this view.'
                            : BETA_FILE_EDIT_DISABLED_MESSAGE}
                        </AlertDescription>
                      </Alert>
                    </div>
                  )}
                  <Suspense fallback={<EditorLoadingFallback />}>
                    <MonacoEditor
                      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
                      language={getLanguageForPath(activeTab.path)}
                      options={editorOptions}
                      keepCurrentModel
                      height="100%"
                      onMount={(editor, monaco) => {
                        editorRef.current = editor;
                        monacoRef.current = monaco;
                        editorDisposedRef.current = false;
                        editor.onDidDispose(() => {
                          if (editorRef.current === editor) {
                            editorDisposedRef.current = true;
                            editorRef.current = null;
                          }
                        });
                        setMonacoReady(true);
                        const readOnlyContribution = editor.getContribution(
                          'editor.contrib.readOnlyMessageController'
                        ) as { dispose?: () => void } | null;
                        readOnlyContribution?.dispose?.();
                        editor.onDidAttemptReadOnlyEdit(() => {
                          showReadOnlyHint();
                        });
                        editor.addCommand(
                          monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                          () => {
                            const path = activePathRef.current;
                            if (path) {
                              void saveFileRef.current(path);
                            }
                          }
                        );
                        const model = modelsRef.current.get(activeTab.path);
                        if (model && !model.isDisposed()) {
                          editor.setModel(model);
                        }
                      }}
                      className="h-full w-full"
                    />
                  </Suspense>
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <Dialog
        open={dialogState !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
      >
        <DialogContent>
          {dialogState?.type === 'new-file' && (
            <>
              <DialogHeader>
                <DialogTitle>New file</DialogTitle>
                <DialogDescription>
                  Create a new file in {dialogState.parentPath}.
                </DialogDescription>
              </DialogHeader>
              {dialogError && (
                <Alert variant="destructive">
                  <AlertTitle>Name already exists</AlertTitle>
                  <AlertDescription>{dialogError}</AlertDescription>
                </Alert>
              )}
              <InputGroup>
                <InputGroupAddon>
                  <FileText className="size-3.5" />
                </InputGroupAddon>
                <InputGroupInput
                  value={dialogName}
                  onChange={(event) => {
                    setDialogName(event.target.value);
                    setDialogError(null);
                  }}
                  placeholder="Filename"
                />
              </InputGroup>
            </>
          )}
          {dialogState?.type === 'new-folder' && (
            <>
              <DialogHeader>
                <DialogTitle>New folder</DialogTitle>
                <DialogDescription>
                  Create a new folder in {dialogState.parentPath}.
                </DialogDescription>
              </DialogHeader>
              {dialogError && (
                <Alert variant="destructive">
                  <AlertTitle>Name already exists</AlertTitle>
                  <AlertDescription>{dialogError}</AlertDescription>
                </Alert>
              )}
              <InputGroup>
                <InputGroupAddon>
                  <Folder className="size-3.5" />
                </InputGroupAddon>
                <InputGroupInput
                  value={dialogName}
                  onChange={(event) => {
                    setDialogName(event.target.value);
                    setDialogError(null);
                  }}
                  placeholder="Folder name"
                />
              </InputGroup>
            </>
          )}
          {dialogState?.type === 'rename' && (
            <>
              <DialogHeader>
                <DialogTitle>Rename item</DialogTitle>
                <DialogDescription>
                  Rename {dialogState.path}.
                </DialogDescription>
              </DialogHeader>
              {dialogError && (
                <Alert variant="destructive">
                  <AlertTitle>Name already exists</AlertTitle>
                  <AlertDescription>{dialogError}</AlertDescription>
                </Alert>
              )}
              <InputGroup>
                <InputGroupAddon>
                  <File className="size-3.5" />
                </InputGroupAddon>
                <InputGroupInput
                  value={dialogName}
                  onChange={(event) => {
                    setDialogName(event.target.value);
                    setDialogError(null);
                  }}
                  placeholder="New name"
                />
              </InputGroup>
            </>
          )}
          {dialogState?.type === 'delete' && (
            <>
              <DialogHeader>
                <DialogTitle>Delete {dialogState.kind}?</DialogTitle>
                <DialogDescription>
                  {dialogState.path} will be permanently removed with no way to recover it. <br></br><br></br>
                  Claude may reference this elsewhere. Unless you are certain, ask Claude to handle the deletion in chat.
                </DialogDescription>
              </DialogHeader>
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              variant={dialogState?.type === 'delete' ? 'destructive' : 'default'}
              onClick={handleConfirmDialog}
              disabled={
                !canMutate ||
                dialogSubmitting ||
                ((dialogState?.type === 'new-file' ||
                  dialogState?.type === 'new-folder' ||
                  dialogState?.type === 'rename') &&
                  !dialogName.trim())
              }
            >
              {dialogSubmitting
                ? 'Working...'
                : dialogState?.type === 'delete'
                  ? 'Delete'
                  : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={conflictState !== null}
        onOpenChange={() => setConflictState(null)}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Save conflict detected</DialogTitle>
            <DialogDescription>
              Another change was detected on disk. Compare and decide how to
              proceed.
            </DialogDescription>
          </DialogHeader>
          {conflictState && (
            <div className="space-y-3">
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div>Your changes</div>
                <div>Disk version</div>
              </div>
              <div className="h-[360px]">
                <Suspense fallback={<EditorLoadingFallback />}>
                  <MonacoDiffEditor
                    theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
                    language={getLanguageForPath(conflictState.path)}
                    original={conflictState.localContent}
                    modified={conflictState.remoteContent}
                    options={{ readOnly: true, renderSideBySide: true }}
                    height="100%"
                  />
                </Suspense>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConflictState(null)}>
              Close
            </Button>
            {conflictState && (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    const model = modelsRef.current.get(conflictState.path);
                    if (model && !model.isDisposed()) {
                      model.setValue(conflictState.remoteContent);
                      savedHashesRef.current.set(
                        conflictState.path,
                        hashString(conflictState.remoteContent)
                      );
                      versionsRef.current.set(
                        conflictState.path,
                        conflictState.remoteVersion
                      );
                      updateTab(conflictState.path, (tab) => ({
                        ...tab,
                        isDirty: false,
                      }));
                    } else {
                      void openFile(conflictState.path, { focus: false });
                    }
                    setConflictState(null);
                  }}
                >
                  Reload from disk
                </Button>
                <Button
                  disabled={!canMutate}
                  onClick={() => {
                    void saveFile(conflictState.path, true);
                    setConflictState(null);
                  }}
                >
                  Overwrite disk
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
    </div>
  );
}
