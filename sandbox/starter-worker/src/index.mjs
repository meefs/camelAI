export default {
  async fetch(request) {
    const url = new URL(request.url);
    return new Response(
      JSON.stringify(
        {
          ok: true,
          message: "Hello from the Chiridion starter Worker (WFP).",
          pathname: url.pathname,
          method: request.method
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  }
};

