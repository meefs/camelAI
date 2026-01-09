export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="max-w-2xl text-center space-y-6">
        <h1 className="text-4xl font-bold tracking-tight">
          {{PROJECT_NAME}}
        </h1>
        <p className="text-lg text-gray-600">
          Your Next.js app is running on Cloudflare Workers.
        </p>
        <div className="flex gap-4 justify-center">
          <a
            href="/api/hello"
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Test API
          </a>
          <a
            href="https://developers.cloudflare.com/workers/"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Documentation
          </a>
        </div>
      </div>
    </main>
  );
}
