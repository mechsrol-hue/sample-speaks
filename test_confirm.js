async function testConfirm() {
    const payload = {
        samples: [{
            encodedCode: "TEST-1234",
            isNumber: "IS 1234",
            quantity: "1",
            priorityLevel: "Priority",
            receivedOn: "10-10-2025",
            forwardedOn: "10-10-2025",
            assignedTo: "Test User",
            totalTest: "5",
            pendingTest: "5",
            approvedTest: ""
        }],
        duplicates: [],
        duplicateCount: 0,
        fileName: "test.xlsx",
        uploadedBy: "Admin"
    };

    try {
        const response = await fetch('http://localhost:3000/api/confirm-upload', {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });
        const text = await response.text();
        console.log('Status:', response.status);
        console.log('Response:', text);
    } catch (e) {
        console.error('Error:', e);
    }
}

testConfirm();
