-- Keep the app role unable to write arbitrary public reference rows. This
-- narrowly scoped owner-owned function only writes BOI foreign-to-ILS rates.
CREATE OR REPLACE FUNCTION public.upsert_boi_fx_rate(
  p_from_currency text, p_date date, p_rate numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.fx_rates (from_currency, to_currency, date, rate, source)
  VALUES (p_from_currency, 'ILS', p_date, p_rate, 'boi')
  ON CONFLICT (from_currency, to_currency, date, source)
  DO UPDATE SET rate = EXCLUDED.rate, updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_boi_fx_rate(text, date, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_boi_fx_rate(text, date, numeric) TO moni_app;
