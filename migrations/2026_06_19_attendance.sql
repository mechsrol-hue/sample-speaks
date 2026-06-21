-- 2026_06_19_attendance.sql
CREATE TABLE IF NOT EXISTS employee_attendance (
    id              bigserial PRIMARY KEY,
    employeeId      bigint REFERENCES employee_profiles(id) ON DELETE CASCADE,
    attendanceDate  date NOT NULL DEFAULT CURRENT_DATE,
    status          text NOT NULL DEFAULT 'present', -- present | absent
    UNIQUE(employeeId, attendanceDate)
);
CREATE INDEX IF NOT EXISTS att_date_idx ON employee_attendance(attendanceDate);
