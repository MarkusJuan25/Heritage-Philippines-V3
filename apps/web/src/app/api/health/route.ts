export const runtime = 'nodejs';

export async function GET() {
  return Response.json({
    status: 'ok',
    service: 'heritage-philippines-v3-web',
    timestamp: new Date().toISOString(),
  });
}
