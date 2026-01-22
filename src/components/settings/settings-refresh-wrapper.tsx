"use client"

import type { ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useNavigate } from 'react-router';

import { useAuth } from "@/contexts/AuthContext"

interface SettingsRefreshWrapperProps {
  children: ReactNode
}

export function SettingsRefreshWrapper({ children }: SettingsRefreshWrapperProps) {
  const navigate = useNavigate()
  const { currentOrg, currentWorkspace } = useAuth()
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
      // TODO: implement refresh
      return
    }

    prevOrgRef.current = nextOrgId
    prevWorkspaceRef.current = nextWorkspaceId
  }, [currentOrg?.id, currentWorkspace?.id, navigate])

  return <>{children}</>
}
