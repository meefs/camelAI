'use client';

import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import type { User } from '@/types';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { AvatarPicker } from '@/components/settings/avatar-picker';
import { getContrastTextColor } from '@/lib/avatar';

interface UserEditFormProps {
  user: User;
}

export function UserEditForm({ user }: UserEditFormProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [name, setName] = useState(user.name || '');
  const [isSuperuser, setIsSuperuser] = useState(user.is_superuser);
  const [avatar, setAvatar] = useState(user.avatar);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const saving = fetcher.state !== 'idle';

  // Handle response
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        toast.success('User updated');
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error);
      }
    }
  }, [fetcher.state, fetcher.data]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetcher.submit(
      {
        intent: 'updateUser',
        name: name || '',
        isSuperuser: isSuperuser ? 'true' : 'false',
        avatarColor: avatar.color,
        avatarContent: avatar.content,
      },
      { method: 'POST' }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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

      <Button type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save Changes'}
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
