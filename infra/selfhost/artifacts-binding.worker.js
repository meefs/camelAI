class LocalGitArtifactsBinding {
  constructor(env) {
    this.baseUrl = String(env.baseUrl || "").replace(/\/+$/, "");
    this.secret = String(env.secret || "");
    this.defaultBranch = String(env.defaultBranch || "main");
    if (!this.baseUrl) throw new Error("Local Artifacts binding requires baseUrl");
    if (!this.secret) throw new Error("Local Artifacts binding requires secret");
  }

  async create(name, options = {}) {
    const payload = await this.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: options.description,
        defaultBranch: options.setDefaultBranch || this.defaultBranch,
      }),
    });
    return this.normalizeRepo(payload, name);
  }

  async get(name) {
    const payload = await this.request(`/api/repos/${encodeURIComponent(name)}`);
    return new LocalGitArtifactsRepo(this, this.normalizeRepo(payload, name));
  }

  async createToken(name, scope = "write", ttlSeconds = 600) {
    const payload = await this.request(`/api/repos/${encodeURIComponent(name)}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, ttlSeconds }),
    });
    if (typeof payload.token !== "string" || !payload.token) {
      throw new Error(`Local Artifacts service did not return a token for ${name}`);
    }
    return {
      plaintext: payload.token,
      expiresAt: typeof payload.expiresAt === "string" || typeof payload.expiresAt === "number"
        ? payload.expiresAt
        : undefined,
    };
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("X-Local-Artifacts-Secret", this.secret);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error((await response.text()) || `Local Artifacts service returned ${response.status}`);
    }
    const payload = await response.json().catch(() => undefined);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Local Artifacts service returned invalid JSON");
    }
    return payload;
  }

  normalizeRepo(payload, fallbackName) {
    const name = typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : fallbackName;
    return {
      id: typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : name,
      name,
      remote: `${this.baseUrl}/git/${encodeURIComponent(name)}.git`,
      defaultBranch: typeof payload.defaultBranch === "string" && payload.defaultBranch.trim()
        ? payload.defaultBranch.trim()
        : this.defaultBranch,
      status: "ready",
    };
  }
}

class LocalGitArtifactsRepo {
  constructor(binding, info) {
    this.binding = binding;
    this.id = info.id;
    this.name = info.name;
    this.remote = info.remote;
    this.defaultBranch = info.defaultBranch;
    this.status = info.status;
  }

  createToken(scope = "write", ttl = 600) {
    return this.binding.createToken(this.name, scope, ttl);
  }
}

export default function makeBinding(env) {
  return new LocalGitArtifactsBinding(env);
}
