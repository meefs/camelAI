"use client"

import type { ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useRevalidator } from 'react-router';

import { useAuthData } from "@/hooks/use-auth-data"

interface SettingsRefreshWrapperProps {
  children: ReactNode
}

export function SettingsRefreshWrapper({ children }: SettingsRefreshWrapperProps) {
  const revalidator = useRevalidator()
  const { currentOrg, currentWorkspace } = useAuthData()
  const prevOrgRef = useRef<string | undefined>(currentOrg?.id)
  const prevWorkspaceRef = useRef<string | undefined>(currentWorkspace?.id)

  useEffect(() => {
    const nextOrgId = currentOrg?.id
    const nextWorkspaceId = currentWorkspace?.id
    const orgChanged =
      nextOrgId && prevOrgRef.current && nextOrgId !== prevOrgRef.current
    const workspaceChanged =
      nextWorkspaceId &&
      prevWorkspaceRef.current &&
      nextWorkspaceId !== prevWorkspaceRef.current

    if (orgChanged || workspaceChanged) {
      prevOrgRef.current = nextOrgId
      prevWorkspaceRef.current = nextWorkspaceId
      // Revalidate to refresh settings data for new org/workspace
      if (revalidator.state === 'idle') {
        revalidator.revalidate()
      }
      return
    }

    prevOrgRef.current = nextOrgId
    prevWorkspaceRef.current = nextWorkspaceId
  }, [currentOrg?.id, currentWorkspace?.id, revalidator])

  return <>{children}</>
}
