export default {
  async fetch(): Promise<Response> {
    return new Response('OpenNext mock - not available in tests', { status: 404 });
  },
};
