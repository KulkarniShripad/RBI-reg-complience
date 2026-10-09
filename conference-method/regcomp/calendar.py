"""Bank working days: Sundays, second and fourth Saturdays and national holidays
(26 January, 15 August, 2 October) are not working days."""
from __future__ import annotations

from datetime import date, timedelta

NATIONAL_HOLIDAYS = {(1, 26), (8, 15), (10, 2)}


def is_working_day(d: date) -> bool:
    if d.weekday() == 6:
        return False
    if d.weekday() == 5 and 8 <= d.day <= 14:      # second Saturday
        return False
    if d.weekday() == 5 and 22 <= d.day <= 28:     # fourth Saturday
        return False
    return (d.month, d.day) not in NATIONAL_HOLIDAYS


def add_working_days(start: date, n: int) -> date:
    d = start
    while n > 0:
        d += timedelta(days=1)
        if is_working_day(d):
            n -= 1
    return d
