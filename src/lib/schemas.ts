import { z } from 'zod';

// Profile - form fields only (for client-side validation)
export const profileFormSchema = z.object({
  name: z.string().max(100, 'Name must be 100 characters or less').optional(),
  avatarColor: z.string().optional(),
  avatarContent: z.string().optional(),
});

// Profile - full submission (for server-side validation)
export const profileSchema = profileFormSchema.extend({
  intent: z.literal('updateProfile'),
});

// Organization - form fields only
export const orgNameFormSchema = z.object({
  name: z.string().min(1, 'Organization name is required').max(100, 'Organization name must be 100 characters or less'),
});

// Organization - full submission
export const orgNameSchema = orgNameFormSchema.extend({
  intent: z.literal('updateOrgName'),
});

// Workspace - form fields only
export const workspaceFormSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100, 'Workspace name must be 100 characters or less'),
  description: z.string().max(200, 'Description must be 200 characters or less').optional(),
  avatarColor: z.string().optional(),
  avatarContent: z.string().optional(),
});

// Workspace - full submission
export const workspaceSchema = workspaceFormSchema.extend({
  intent: z.literal('updateWorkspace'),
});

// Create workspace - form fields only
export const createWorkspaceFormSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100, 'Workspace name must be 100 characters or less'),
  description: z.string().max(200, 'Description must be 200 characters or less').optional(),
});

// Create workspace - full submission
export const createWorkspaceSchema = createWorkspaceFormSchema.extend({
  intent: z.literal('createWorkspace'),
});

// Create org - form fields only
export const createOrgFormSchema = z.object({
  name: z.string().min(1, 'Organization name is required').max(100, 'Organization name must be 100 characters or less'),
});

// Create org - full submission
export const createOrgSchema = createOrgFormSchema.extend({
  intent: z.literal('createOrg'),
});

// Invite member - form fields only
export const inviteMemberFormSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

// Invite member - full submission (uses createInvitation intent)
export const inviteMemberSchema = inviteMemberFormSchema.extend({
  intent: z.literal('createInvitation'),
});
