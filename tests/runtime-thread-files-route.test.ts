import { beforeEach, describe, expect, it, vi } from "vitest";
import { scratchVolumePath } from "@/lib/agent-runtime-shared";

const requireRuntimeThreadMock = vi.fn();
const threadScratchVolumeMock = vi.fn();
const fetchScratchFileMock = vi.fn();
vi.mock("@/lib/runtime-threads.server", () => ({
  requestWorkspaceId: () => null,
  requireRuntimeThread: requireRuntimeThreadMock,
}));
vi.mock("../workers/main/src/agent-runtime/thread-runtime", () => ({
  threadScratchVolume: threadScratchVolumeMock,
  fetchScratchFile: fetchScratchFileMock,
}));

const { loader } = await import("@/routes/api/threads.$id.files.$");

function get(splat: string, query = "", headers: Record<string, string> = {}) {
  return loader({
    request: new Request(`https://camelai.test/api/threads/t1/files/${splat}${query}`, { headers }),
    context: {},
    params: { id: "t1", "*": splat },
  } as never) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRuntimeThreadMock.mockResolvedValue({ env: {}, context: { threadId: "t1" }, row: { agentId: "agt_1" } });
  threadScratchVolumeMock.mockResolvedValue("vol_1");
});

describe("scratchVolumePath", () => {
  it("maps the agent's /workspace paths into its volume, and nothing else", () => {
    expect(scratchVolumePath("/workspace/out/chart.png")).toBe("/out/chart.png");
    for (const path of ["/workspace", "/workspace/", "/etc/passwd", "/workspace/../x", "/workspace/a/./b", "workspace/x", "/workspace/a\nb"]) {
      expect(scratchVolumePath(path)).toBeNull();
    }
  });
});

describe("GET /api/threads/:id/files/*", () => {
  it("serves a scratch file from chiridion's origin, typed by its name, after the thread's access check", async () => {
    fetchScratchFileMock.mockResolvedValue(new Response("a,b\n1,2\n", { headers: { "Content-Length": "8", "Content-Type": "application/octet-stream" } }));
    const response = await get("workspace/out/data%20v2.csv");
    expect(requireRuntimeThreadMock).toHaveBeenCalled();
    expect(fetchScratchFileMock).toHaveBeenCalledWith({}, "vol_1", "/out/data v2.csv", null);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="data v2.csv"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("a,b\n1,2\n");
  });

  it("sandboxes HTML, so a report opened on its own never runs as the app's origin", async () => {
    fetchScratchFileMock.mockResolvedValue(new Response("<script>1</script>"));
    const response = await get("workspace/report.html");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toMatch(/^sandbox /);
    expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  });

  it("downloads on request, passes ranges through, and answers 404 for what is not there", async () => {
    fetchScratchFileMock.mockResolvedValue(new Response("pdf", { status: 206, headers: { "Content-Range": "bytes 0-2/10" } }));
    const partial = await get("workspace/a.pdf", "?download=1", { range: "bytes=0-2" });
    expect(fetchScratchFileMock).toHaveBeenLastCalledWith({}, "vol_1", "/a.pdf", "bytes=0-2");
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(partial.headers.get("content-range")).toBe("bytes 0-2/10");

    fetchScratchFileMock.mockResolvedValue(new Response("{}", { status: 404 }));
    expect((await get("workspace/gone.txt")).status).toBe(404);
    expect((await get("etc/passwd")).status).toBe(400);
    threadScratchVolumeMock.mockResolvedValue(null);
    expect((await get("workspace/x.txt")).status).toBe(404);
  });
});
