import { useState } from "react";

export default function App() {
  const [apiResponse, setApiResponse] = useState<string | null>(null);

  async function testApi() {
    try {
      const response = await fetch("/api/hello");
      const data = await response.json();
      setApiResponse(JSON.stringify(data, null, 2));
    } catch (error) {
      setApiResponse(`Error: ${error}`);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="max-w-2xl text-center space-y-6">
        <h1 className="text-4xl font-bold tracking-tight">{"{{PROJECT_NAME}}"}</h1>
        <p className="text-lg text-zinc-600">
          Your React app is running on Cloudflare Workers.
        </p>
        <div className="flex gap-4 justify-center">
          <button
            onClick={testApi}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Test API
          </button>
          <a
            href="https://developers.cloudflare.com/workers/"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 border border-zinc-300 rounded-lg hover:bg-zinc-50 transition-colors"
          >
            Documentation
          </a>
        </div>
        {apiResponse && (
          <pre className="mt-4 p-4 bg-zinc-100 rounded-lg text-left text-sm overflow-auto">
            {apiResponse}
          </pre>
        )}
      </div>
    </main>
  );
}
