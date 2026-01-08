import { Separator } from "@/components/ui/separator"
import { SettingsHeader } from "@/components/settings/settings-header"
import { ProfileForm } from "@/components/settings/profile-form"
import { requireAuthContextLite } from "@/lib/server-guards"

export default async function ProfilePage() {
  const { user } = await requireAuthContextLite()
  const safeUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    is_superuser: user.is_superuser,
    avatar: {
      color: user.avatar.color,
      content: user.avatar.content,
    },
    is_orphaned: user.is_orphaned,
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Profile"
        description="Manage your personal account settings."
      />
      <Separator />
      <ProfileForm user={safeUser} />
    </div>
  )
}
