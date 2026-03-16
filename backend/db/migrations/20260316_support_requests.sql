-- Support requests table: captures farmer complaints, refund requests, and delivery issues
-- logged by the AI agent (Fatima) during live sessions.

CREATE TABLE IF NOT EXISTS public.support_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone text NOT NULL,
    farmer_name text,
    category text NOT NULL DEFAULT 'complaint',
    title text NOT NULL,
    description text NOT NULL,
    order_reference text,
    status text NOT NULL DEFAULT 'open',
    priority text NOT NULL DEFAULT 'medium',
    admin_notes text,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_requests_phone_e164_chk
        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
    CONSTRAINT support_requests_category_chk
        CHECK (category IN ('complaint', 'refund', 'delivery', 'product', 'other')),
    CONSTRAINT support_requests_status_chk
        CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    CONSTRAINT support_requests_priority_chk
        CHECK (priority IN ('low', 'medium', 'high', 'urgent'))
);

CREATE INDEX IF NOT EXISTS idx_support_requests_phone
    ON public.support_requests(phone);

CREATE INDEX IF NOT EXISTS idx_support_requests_status
    ON public.support_requests(status);

CREATE INDEX IF NOT EXISTS idx_support_requests_created_at
    ON public.support_requests(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_requests_category
    ON public.support_requests(category);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_support_requests_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_requests_updated_at ON public.support_requests;
CREATE TRIGGER trg_support_requests_updated_at
BEFORE UPDATE ON public.support_requests
FOR EACH ROW
EXECUTE FUNCTION public.touch_support_requests_updated_at();

-- RLS disabled — inserts from agent use service role key; admin reads via service role.
ALTER TABLE public.support_requests DISABLE ROW LEVEL SECURITY;
