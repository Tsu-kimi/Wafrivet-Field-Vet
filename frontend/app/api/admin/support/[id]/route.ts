/**
 * PATCH /api/admin/support/[id] — update status, priority, or admin_notes
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/admin-auth';
import { adminSupabase } from '@/app/lib/admin-supabase';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const VALID_STATUSES   = new Set(['open', 'in_progress', 'resolved', 'closed']);
  const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

  const patch: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (!VALID_STATUSES.has(String(body.status))) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    patch.status = body.status;
    if (body.status === 'resolved' || body.status === 'closed') {
      patch.resolved_at = new Date().toISOString();
    } else {
      patch.resolved_at = null;
    }
  }

  if (body.priority !== undefined) {
    if (!VALID_PRIORITIES.has(String(body.priority))) {
      return NextResponse.json({ error: 'Invalid priority' }, { status: 400 });
    }
    patch.priority = body.priority;
  }

  if (body.admin_notes !== undefined) {
    patch.admin_notes = body.admin_notes === '' ? null : String(body.admin_notes);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const { data, error } = await adminSupabase
    .from('support_requests')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ request: data });
}
