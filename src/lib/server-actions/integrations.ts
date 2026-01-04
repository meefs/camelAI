"use server";

import {
  getAllCategories,
  getAllIntegrations,
  getIntegrationsByCategory,
} from "@/lib/integration-registry";
import type { IntegrationCategory } from "@/types";

export async function getIntegrationTypes(category?: IntegrationCategory | null) {
  if (category) {
    return { integrations: getIntegrationsByCategory(category) };
  }
  return {
    integrations: getAllIntegrations(),
    categories: getAllCategories(),
  };
}
