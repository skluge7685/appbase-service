
module.exports = async function(work_package, service_data, logger) {

    return new Promise((resolve, reject) => {

        const response = {code: 200, status: 'OK', message: 'Das ist ein Test.', data: {}, service: {message: 'Fehler'}, success: true};
        console.log(work_package);

        resolve(response);
    })
    
}