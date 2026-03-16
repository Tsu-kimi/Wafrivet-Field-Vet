from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _add_project_root_to_path() -> None:
    """
    Ensure the repository root is on sys.path so we can import backend modules
    when running this script directly with `python scripts/test_termii_sms.py`.
    """
    script_path = Path(__file__).resolve()
    project_root = script_path.parents[1]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))


def main() -> int:
    _add_project_root_to_path()

    # Import after sys.path adjustment so the package resolves correctly.
    from backend.services.otp_service import _send_otp_sms  # type: ignore[attr-defined]

    parser = argparse.ArgumentParser(
        description=(
            "Send a test SMS via Termii using the same code path as OTP SMS.\n\n"
            "Requirements:\n"
            "  - TERMII_API_KEY must be set in the environment\n"
            "  - Optional: TERMII_SENDER_ID (defaults to 'N-Alert')\n\n"
            "Example:\n"
            "  python scripts/test_termii_sms.py +2347012345678 "
            "'WafriVet test SMS – if you received this, Termii is working.'"
        )
    )
    parser.add_argument(
        "phone",
        help="Destination phone number in E.164 format, e.g. +2347012345678",
    )
    parser.add_argument(
        "message",
        nargs="?",
        default="WafriVet test SMS – if you received this, Termii is working.",
        help="SMS body to send (optional).",
    )

    args = parser.parse_args()

    api_key = os.environ.get("TERMII_API_KEY", "").strip()
    if not api_key:
        print("ERROR: TERMII_API_KEY is not set in the environment.")
        return 1

    print(f"Sending Termii SMS to {args.phone!r} ...")
    print(f"Using sender ID: {os.environ.get('TERMII_SENDER_ID', 'N-Alert')!r}")

    try:
        msg_id = _send_otp_sms(args.phone, args.message)
    except Exception as exc:  # noqa: BLE001
        print(f"Exception while calling Termii: {exc}")
        return 1

    if msg_id:
        print(f"SUCCESS: Termii accepted the SMS. message_id={msg_id!r}")
        return 0

    print("FAILED: Termii SMS was not dispatched (check backend logs for details).")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

