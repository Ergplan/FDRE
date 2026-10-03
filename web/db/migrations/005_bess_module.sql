-- Saved scenarios from the BESS Tender tab use module 'bess'.
ALTER TABLE scenarios DROP CONSTRAINT IF EXISTS scenarios_module_check;
ALTER TABLE scenarios ADD CONSTRAINT scenarios_module_check CHECK (module IN ('rtc', 'fdre', 'bess'));
