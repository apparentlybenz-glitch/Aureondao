-- Minimum premium floor for an enabled option period.
--
-- A win pays floor(premium x profit_rate_bps / 10000) on top of the premium and the
-- opening fee is ceil(premium x fee_bps / 10000), so a win nets
--   floor(p x r / 10000) - ceil(p x f / 10000)
-- cents. Below a floor that net is 0 or negative: the user "wins" and still loses
-- the fee. Rounding takes at most 2 cents off the exact value (p x (r - f) / 10000),
-- so (r - f) x p > 20000 guarantees a net win of at least 1 cent for this premium
-- and for every larger one. At 600 bps and a 10 bps fee that is a floor of 34 cents
-- (a win nets 1). A period whose rate is not above its fee can never be enabled.
--
-- min_premium_cents is a plain column written only by admin_set_option_period (and
-- the migration seed), so the rule is a CHECK: it also covers a direct write.
-- Disabled periods (rate 0 in the seed) are exempt. The live row (30 s, 600 bps,
-- 10 bps, 4900 cents) satisfies it: 590 x 4900 = 2,891,000.

alter table public.option_periods
  add constraint option_periods_min_premium_floor
  check (not enabled or (profit_rate_bps - fee_bps)::bigint * min_premium_cents > 20000);
