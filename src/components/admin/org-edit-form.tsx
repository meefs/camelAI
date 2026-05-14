'use client';

import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';
import type { BillingStatus, Organization } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface OrgEditFormProps {
  org: Pick<Organization, 'name' | 'billing_status'>;
}

const BILLING_STATUS_OPTIONS: Array<{
  value: BillingStatus;
  label: string;
  description: string;
}> = [
  {
    value: 'inactive',
    label: 'Pay as you go',
    description: 'Requires prepaid credits for hosted usage.',
  },
  {
    value: 'trialing',
    label: 'Trial',
    description: 'Allows access without consuming credits.',
  },
  {
    value: 'active',
    label: 'Active',
    description: 'Requires credits for hosted usage.',
  },
  {
    value: 'enterprise',
    label: 'Enterprise',
    description: 'Bypasses Stripe subscription and credits.',
  },
  {
    value: 'past_due',
    label: 'Past due',
    description: 'Blocks hosted usage until billing is resolved.',
  },
  {
    value: 'canceled',
    label: 'Canceled',
    description: 'Blocks hosted usage until a new plan starts.',
  },
];

export function OrgEditForm({ org }: OrgEditFormProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [name, setName] = useState(org.name);
  const [billingStatus, setBillingStatus] = useState<BillingStatus>(
    org.billing_status,
  );
  const saving = fetcher.state !== 'idle';

  useEffect(() => {
    setName(org.name);
    setBillingStatus(org.billing_status);
  }, [org.name, org.billing_status]);

  // Handle response
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      if (fetcher.data.success) {
        toast.success('Organization updated');
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error);
      }
    }
  }, [fetcher.state, fetcher.data]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetcher.submit(
      {
        intent: 'updateOrg',
        name: name.trim(),
        billingStatus,
      },
      { method: 'POST' }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Organization Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter organization name"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="billing-status">Billing Status</Label>
        <Select
          value={billingStatus}
          onValueChange={(value) => setBillingStatus(value as BillingStatus)}
        >
          <SelectTrigger id="billing-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BILLING_STATUS_OPTIONS.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                description={option.description}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Use <span className="font-medium">Enterprise</span> for orgs you bill
          outside Stripe.
        </p>
      </div>

      <Button type="submit" disabled={saving}>
        {saving ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  );
}
