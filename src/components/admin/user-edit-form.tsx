'use client';

import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { User } from '@/types';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AvatarPicker } from '@/components/settings/avatar-picker';
import { getContrastTextColor } from '@/lib/avatar';
import { updateAdminUser } from '@/lib/server-actions/admin';

interface UserEditFormProps {
  user: User;
}

export function UserEditForm({ user }: UserEditFormProps) {
  const navigate = useNavigate();
  const [name, setName] = useState(user.name || '');
  const [isSuperuser, setIsSuperuser] = useState(user.is_superuser);
  const [avatar, setAvatar] = useState(user.avatar);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await updateAdminUser(user.id, {
        name: name || null,
        is_superuser: isSuperuser,
        avatar,
      });

      setSuccess(true);
      // TODO: implement refresh;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <AlertDescription>User updated successfully</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="name">Display Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter display name"
        />
      </div>

      <div className="flex items-center gap-4">
        <Avatar size="lg">
          <AvatarFallback
            content={avatar.content}
            style={{
              backgroundColor: avatar.color,
              color: getContrastTextColor(avatar.color),
            }}
          >
            {avatar.content}
          </AvatarFallback>
        </Avatar>
        <Button
          variant="outline"
          type="button"
          onClick={() => setAvatarOpen(true)}
        >
          Change avatar
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Checkbox
          id="superuser"
          checked={isSuperuser}
          onCheckedChange={(checked) => setIsSuperuser(checked === true)}
        />
        <div className="space-y-0.5">
          <Label htmlFor="superuser">Superuser</Label>
          <p className="text-xs text-muted-foreground">
            Grant full admin access to this user
          </p>
        </div>
      </div>

      <Button type="submit" disabled={loading}>
        {loading ? 'Saving...' : 'Save Changes'}
      </Button>

      <AvatarPicker
        open={avatarOpen}
        onOpenChange={setAvatarOpen}
        value={avatar}
        onChange={setAvatar}
        title="User avatar"
        description="Update the user avatar and initials."
      />
    </form>
  );
}
