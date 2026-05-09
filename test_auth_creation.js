// Test script to verify auth account creation
require('dotenv').config();
const { supabaseAdmin } = require('./src/config/supabase');
const employeeCredentialsService = require('./src/services/employeeCredentials.service');

async function testAuthCreation() {
  try {
    console.log('Testing auth account creation...');
    
    const testEmployee = {
      id: '00000000-0000-0000-0000-000000000001',
      email: `test.employee.${Date.now()}@company.com`,
      employee_code: 'HH-TEST',
      full_name: 'Test Employee',
      org_id: '19f84f2b-b0cd-4b60-88d7-294e36c657f7'
    };
    
    const result = await employeeCredentialsService.createEmployeeAccount(
      testEmployee,
      '38fe0784-4372-49a7-8c6e-a9d267b28fad'
    );
    
    console.log('✅ Auth account created successfully:');
    console.log('- Employee ID:', result.employee.id);
    console.log('- User ID:', result.employee.user_id);
    console.log('- Auth User ID:', result.auth_user.id);
    console.log('- Email:', result.credentials.email);
    console.log('- Password:', result.credentials.password);
    
  } catch (error) {
    console.error('❌ Auth account creation failed:', error.message);
    console.error('Full error:', error);
  }
}

testAuthCreation();
