/**
 * GET  /api/admin/support  — paginated list of support requests with optional filters
 * PATCH /api/admin/support — bulk status update (unused for now, reserved)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/app/lib/admin-auth';
import { adminSupabase } from '@/app/lib/admin-supabase';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status   = searchParams.get('status')   ?? '';
  const category = searchParams.get('category') ?? '';
  const priority = searchParams.get('priority') ?? '';
  const search   = searchParams.get('search')   ?? '';
  const page     = Math.max(1, Number(searchParams.get('page') ?? '1'));
  const limit    = 25;
  const from     = (page - 1) * limit;
  const to       = from + limit - 1;

  let query = adminSupabase
    .from('support_requests')
    .select(
      'id, phone, farmer_name, category, title, description, order_reference, status, priority, admin_notes, resolved_at, created_at, updated_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status)   query = query.eq('status', status);
  if (category) query = query.eq('category', category);
  if (priority) query = query.eq('priority', priority);
  if (search)   query = query.or(`phone.ilike.%${search}%,farmer_name.ilike.%${search}%,title.ilike.%${search}%,order_reference.ilike.%${search}%`);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ requests: data ?? [], total: count ?? 0, page, limit });
}
