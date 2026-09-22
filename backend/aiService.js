import { GoogleGenerativeAI } from '@google/generative-ai';
import pool from './db.js';
import dotenv from 'dotenv';

dotenv.config();

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

export const parseAndApplyUpdates = async (textInput, poolOverride = null, apiKeyOverride = null) => {
  const activePool = poolOverride || pool;
  const activeApiKey = apiKeyOverride || process.env.GEMINI_API_KEY;

  if (!activeApiKey) {
    throw new Error('GEMINI_API_KEY is not configured in backend env');
  }

  const activeGenAI = apiKeyOverride ? new GoogleGenerativeAI(activeApiKey) : genAI;
  if (!activeGenAI) {
    throw new Error('Generative AI client is not initialized');
  }

  const model = activeGenAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    generationConfig: { responseMimeType: 'application/json' }
  });

  const prompt = `
You are an expert placement coordinator assistant. Extract all visited companies, placement drives, branches, and placed student details from the text update and return them in a structured JSON object matching the schema below.

Rules:
1. Default visiting_date to current date (assume year is 2026 if not specified) in YYYY-MM-DD format.
2. Default role to 'Software Engineer' if not clear.
3. CTC must be a number representing LPA (Lakhs Per Annum). E.g., '12 LPA' -> 12, '35.5 LPA' -> 35.5, 'INR 8,00,000' -> 8.
4. Default eligibility_10th and eligibility_12th to 50 if not specified.
5. Default eligibility_cgpa to 6.00 if not specified.
6. Default eligibility_backlog to 'No active backlogs' or parse backlog limits if mentioned.
7. Branches must be an array of short branch names (e.g. ['AIDS', 'CE', 'ECE', 'ENTC', 'IT']). Map phrases like 'Computer Engineering' or 'Computer Science' to 'CE', 'Information Technology' to 'IT', 'Electronics and Telecommunication' or 'Electronics & Telecommunication' to 'ENTC', 'Electronics' to 'ECE', 'Artificial Intelligence' or 'Data Science' to 'AIDS'.
8. Placed students must have first_name, last_name, email (or null), department (e.g. AIDS, CE, ECE, ENTC, IT), and placement_date (or default to drive visiting date).

Return JSON with this exact format:
{
  "updates": [
    {
      "company_name": "Company Name",
      "visiting_date": "YYYY-MM-DD",
      "role": "Role Title",
      "jd_link": "URL string or null",
      "ctc": 15.0,
      "eligibility_10th": 70,
      "eligibility_12th": 70,
      "eligibility_cgpa": 7.50,
      "eligibility_backlog": "No active backlogs",
      "branches": ["CE", "IT", "ENTC"],
      "students": [
        {
          "first_name": "First Name",
          "last_name": "Last Name",
          "email": "email@example.com or null",
          "department": "CE",
          "placement_date": "YYYY-MM-DD"
        }
      ]
    }
  ]
}

Text to parse:
"""
${textInput}
"""
`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();
  const parsedData = JSON.parse(responseText);

  if (!parsedData.updates || !Array.isArray(parsedData.updates)) {
    throw new Error('Invalid structure returned from generative AI parser');
  }

  const connection = await activePool.getConnection();
  try {
    await connection.beginTransaction();

    const resultsSummary = [];

    for (const update of parsedData.updates) {
      // 1. Get or create company
      let [companyRows] = await connection.query(
        'SELECT company_id FROM companies WHERE LOWER(company_name) = ?',
        [update.company_name.trim().toLowerCase()]
      );
      let companyId;
      if (companyRows.length > 0) {
        companyId = companyRows[0].company_id;
      } else {
        const [insertCompany] = await connection.query(
          'INSERT INTO companies (company_name) VALUES (?)',
          [update.company_name.trim()]
        );
        companyId = insertCompany.insertId;
      }

      // 2. Check if drive already exists for this company + role
      let [driveRows] = await connection.query(
        'SELECT drive_id FROM placement_drives WHERE company_id = ? AND LOWER(role) = ?',
        [companyId, update.role.trim().toLowerCase()]
      );
      let driveId;
      if (driveRows.length > 0) {
        driveId = driveRows[0].drive_id;
        // Update details
        await connection.query(
          `UPDATE placement_drives SET 
            visiting_date = ?, jd_link = ?, ctc = ?, 
            eligibility_10th = ?, eligibility_12th = ?, eligibility_cgpa = ?, eligibility_backlog = ?
           WHERE drive_id = ?`,
          [
            update.visiting_date,
            update.jd_link,
            update.ctc || 1,
            update.eligibility_10th || 50,
            update.eligibility_12th || 50,
            update.eligibility_cgpa || 6.00,
            update.eligibility_backlog,
            driveId
          ]
        );
      } else {
        // Insert new drive
        const [insertDrive] = await connection.query(
          `INSERT INTO placement_drives (
            company_id, visiting_date, role, jd_link, 
            ctc, eligibility_10th, eligibility_12th, eligibility_cgpa, eligibility_backlog
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            companyId,
            update.visiting_date,
            update.role || 'Software Engineer',
            update.jd_link,
            update.ctc || 1,
            update.eligibility_10th || 50,
            update.eligibility_12th || 50,
            update.eligibility_cgpa || 6.00,
            update.eligibility_backlog
          ]
        );
        driveId = insertDrive.insertId;
      }

      // 3. Update branches
      await connection.query('DELETE FROM branches WHERE drive_id = ?', [driveId]);
      if (update.branches && Array.isArray(update.branches)) {
        for (const branch of update.branches) {
          await connection.query(
            'INSERT INTO branches (drive_id, branch) VALUES (?, ?)',
            [driveId, branch.trim().toUpperCase()]
          );
        }
      }

      // 4. Insert/Update students
      const studentDetails = [];
      const todayDate = new Date().toISOString().split('T')[0];
      if (update.students && Array.isArray(update.students)) {
        for (const stud of update.students) {
          const fName = stud.first_name.trim();
          const lName = stud.last_name.trim();
          const pDate = stud.placement_date || todayDate;

          // Check if student already exists in the database
          let [studRows] = await connection.query(
            'SELECT student_id FROM students WHERE LOWER(student_first_name) = ? AND LOWER(student_last_name) = ?',
            [fName.toLowerCase(), lName.toLowerCase()]
          );

          if (studRows.length > 0) {
            const studentId = studRows[0].student_id;
            await connection.query(
              `UPDATE students SET 
                email = COALESCE(?, email),
                department = COALESCE(?, department),
                placement_date = ?,
                placed_drive_id = ?
               WHERE student_id = ?`,
              [
                stud.email ? stud.email.trim() : null,
                stud.department ? stud.department.trim().toUpperCase() : null,
                pDate,
                driveId,
                studentId
              ]
            );
            studentDetails.push(`${fName} ${lName} (updated)`);
          } else {
            await connection.query(
              `INSERT INTO students (student_first_name, student_last_name, email, department, placement_date, placed_drive_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                fName,
                lName,
                stud.email ? stud.email.trim() : null,
                stud.department ? stud.department.trim().toUpperCase() : null,
                pDate,
                driveId
              ]
            );
            studentDetails.push(`${fName} ${lName} (added)`);
          }
        }
      }

      resultsSummary.push({
        company: update.company_name,
        role: update.role,
        drive_id: driveId,
        branches: update.branches,
        students: studentDetails
      });
    }

    await connection.commit();
    return { success: true, results: resultsSummary };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
};
