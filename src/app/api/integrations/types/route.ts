import { NextResponse } from 'next/server';
import {
  getAllIntegrations,
  getAllCategories,
  getIntegrationsByCategory,
} from '@/lib/integration-registry';
import type { IntegrationCategory } from '@/types';

// GET /api/integrations/types - List available integration types
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category') as IntegrationCategory | null;

  if (category) {
    const integrations = getIntegrationsByCategory(category);
    return NextResponse.json({ integrations });
  }

  const integrations = getAllIntegrations();
  const categories = getAllCategories();

  return NextResponse.json({
    integrations,
    categories,
  });
}
